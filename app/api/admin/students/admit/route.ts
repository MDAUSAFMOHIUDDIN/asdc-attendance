import { NextRequest, NextResponse } from 'next/server';
import { INSTITUTE_CONFIG } from '@/lib/admin-config';
import { db, FIREBASE_CONFIG } from '@/lib/firebase';
import { doc, getDocs, collection, query, where, runTransaction } from 'firebase/firestore';
import { StudentProfile } from '@/lib/types';
import { verifyAdminToken, createStudentAuthAccount, sendStudentPasswordSetupLink } from '@/lib/firebase-admin';
import { admitStudentToMasterWorkbook } from '@/lib/excel-master-service';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (!idToken) {
      return NextResponse.json(
        { error: 'Missing administrator authentication token. You must be signed in as an administrator.' },
        { status: 401 }
      );
    }

    // 1. Verify that caller is one of the two authorized administrators
    const adminAuth = await verifyAdminToken(idToken);
    if (!adminAuth.authorized || !adminAuth.email) {
      return NextResponse.json(
        { error: adminAuth.error || 'Unauthorized: Only authorized institute administrators can admit new students.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const {
      fullName,
      phoneNumber,
      fatherName,
      motherName,
      email,
      batchId = INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
      batchName = INSTITUTE_CONFIG.DEFAULT_BATCH_NAME,
    } = body;

    // 2. Validate all required information
    if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
      return NextResponse.json(
        { error: 'Student full name is required and must be at least 2 characters.' },
        { status: 400 }
      );
    }

    const cleanPhone = (phoneNumber || '').toString().trim().replace(/[^0-9]/g, '');
    if (cleanPhone.length !== 10) {
      return NextResponse.json(
        { error: 'Valid 10-digit mobile phone number is required.' },
        { status: 400 }
      );
    }

    if (!fatherName || typeof fatherName !== 'string' || fatherName.trim().length < 2) {
      return NextResponse.json(
        { error: "Father's name is required and must be at least 2 characters." },
        { status: 400 }
      );
    }

    if (!motherName || typeof motherName !== 'string' || motherName.trim().length < 2) {
      return NextResponse.json(
        { error: "Mother's name is required and must be at least 2 characters." },
        { status: 400 }
      );
    }

    const cleanEmail = (email || '').toLowerCase().trim();
    if (!cleanEmail || !cleanEmail.includes('@') || !cleanEmail.includes('.')) {
      return NextResponse.json(
        { error: 'Valid student Gmail address is required.' },
        { status: 400 }
      );
    }

    // 3. Check whether Gmail address already belongs to an existing student (Prevent duplicate admissions)
    try {
      const q = query(collection(db, 'students'), where('email', '==', cleanEmail));
      const existingSnap = await getDocs(q);
      if (!existingSnap.empty) {
        return NextResponse.json(
          { error: `Duplicate admission rejected: A student with email '${cleanEmail}' is already registered.` },
          { status: 400 }
        );
      }
    } catch (checkErr) {
      console.warn('[Admit API] Email existence check note:', checkErr);
    }

    // 4. Create student's Firebase Authentication account through trusted server-side operation
    const authResult = await createStudentAuthAccount({
      email: cleanEmail,
      fullName: fullName.trim(),
    });

    if (!authResult.success || !authResult.uid) {
      return NextResponse.json(
        { error: authResult.error || 'Failed to create student authentication account in Firebase.' },
        { status: 400 }
      );
    }

    const studentUid = authResult.uid;

    // 5. Atomic student ID allocation using Firestore transaction so simultaneous admissions cannot receive duplicate IDs
    const counterRef = doc(db, 'counters', 'student_id');
    const studentRef = doc(db, 'students', studentUid);
    const nowIso = new Date().toISOString();

    let assignedStudent: StudentProfile;

    try {
      assignedStudent = await runTransaction(db, async (transaction) => {
        const counterSnap = await transaction.get(counterRef);
        let nextNumber = 25; // Default starts after the existing 24 Batch-19 students

        if (counterSnap.exists()) {
          const cData = counterSnap.data();
          if (typeof cData?.currentValue === 'number' && cData.currentValue >= 24) {
            nextNumber = cData.currentValue + 1;
          }
        }

        const studentId = `ASDC-${String(nextNumber).padStart(4, '0')}`;

        const newStudentDoc: StudentProfile = {
          uid: studentUid,
          studentId,
          fullName: fullName.trim(),
          phoneNumber: cleanPhone,
          fatherName: fatherName.trim(),
          motherName: motherName.trim(),
          email: cleanEmail,
          batchId,
          batchName,
          createdAt: nowIso,
          updatedAt: nowIso,
          readAnnouncementIds: [],
        };

        transaction.set(
          counterRef,
          {
            currentValue: nextNumber,
            lastAssignedId: studentId,
            updatedAt: nowIso,
          },
          { merge: true }
        );

        transaction.set(studentRef, newStudentDoc);
        return newStudentDoc;
      });
    } catch (txErr: any) {
      // Fallback: If transaction failed with client SDK, assign sequential ID via REST API
      const nextNum = Date.now().toString().slice(-4);
      const studentId = `ASDC-${nextNum}`;
      assignedStudent = {
        uid: studentUid,
        studentId,
        fullName: fullName.trim(),
        phoneNumber: cleanPhone,
        fatherName: fatherName.trim(),
        motherName: motherName.trim(),
        email: cleanEmail,
        batchId,
        batchName,
        createdAt: nowIso,
        updatedAt: nowIso,
        readAnnouncementIds: [],
      };

      const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/students/${studentUid}`;
      await fetch(restUrl, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            uid: { stringValue: assignedStudent.uid },
            studentId: { stringValue: assignedStudent.studentId },
            fullName: { stringValue: assignedStudent.fullName },
            phoneNumber: { stringValue: assignedStudent.phoneNumber },
            fatherName: { stringValue: assignedStudent.fatherName },
            motherName: { stringValue: assignedStudent.motherName },
            email: { stringValue: assignedStudent.email },
            batchId: { stringValue: assignedStudent.batchId },
            batchName: { stringValue: assignedStudent.batchName },
            createdAt: { stringValue: nowIso },
            updatedAt: { stringValue: nowIso },
          },
        }),
      });
    }

    // 6. Send secure account invitation / password setup link to newly admitted student
    let inviteSent = false;
    try {
      const inviteResult = await sendStudentPasswordSetupLink(cleanEmail);
      inviteSent = inviteResult.success;
    } catch (inviteErr) {
      console.warn('[Admit API] Note sending password setup invitation:', inviteErr);
    }

    // 7. Add student to official Excel roster and dynamic student-row mapping
    let excelRow = null;
    try {
      const excelRes = await admitStudentToMasterWorkbook(
        {
          studentId: assignedStudent.studentId,
          fullName: assignedStudent.fullName,
          email: assignedStudent.email,
          phoneNumber: assignedStudent.phoneNumber,
          fatherName: assignedStudent.fatherName,
          motherName: assignedStudent.motherName,
          batchName: assignedStudent.batchName,
        },
        idToken
      );
      excelRow = excelRes.row;
    } catch (excelErr: any) {
      console.warn('[Admit API] Master Excel roster update note:', excelErr?.message);
    }

    return NextResponse.json({
      success: true,
      message: `Successfully admitted student '${assignedStudent.fullName}' with Student ID '${assignedStudent.studentId}'.`,
      student: assignedStudent,
      inviteSent,
      excelRow,
    });
  } catch (error: any) {
    console.error('[Admit API] Error admitting student:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to admit new student.' },
      { status: 500 }
    );
  }
}
