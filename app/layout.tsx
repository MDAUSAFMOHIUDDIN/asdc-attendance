import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import { PWAInstallBanner } from '@/components/PWAInstallBanner';

export const metadata: Metadata = {
  title: 'ASDC Attendance',
  description: 'Smart, secure institute attendance and student management system for ASDC with classroom QR scanning, verified batch tracking, and real-time administrative reporting.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'ASDC Attendance',
  },
  icons: {
    icon: [
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon.png', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  openGraph: {
    title: 'ASDC Attendance',
    description: 'Smart, secure institute attendance and student management system for ASDC with classroom QR scanning, verified batch tracking, and real-time administrative reporting.',
    type: 'website',
    images: [{ url: '/asdc-logo.png', width: 512, height: 512, alt: 'ASDC Attendance Logo' }],
  },
  twitter: {
    card: 'summary',
    title: 'ASDC Attendance',
    description: 'Smart, secure institute attendance and student management system for ASDC with classroom QR scanning, verified batch tracking, and real-time administrative reporting.',
    images: ['/asdc-logo.png'],
  },
};

export const viewport: Viewport = {
  themeColor: '#2563eb',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png" />
        <link rel="icon" href="/favicon-16x16.png" sizes="16x16" type="image/png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.json" />
      </head>
      <body className="bg-white text-slate-900 antialiased min-h-screen selection:bg-blue-600 selection:text-white" suppressHydrationWarning>
        <ServiceWorkerRegister />
        <PWAInstallBanner />
        {children}
      </body>
    </html>
  );
}
