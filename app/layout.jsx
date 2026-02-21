import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import AuthGate from "@/components/AuthGate";
import SessionDock from "@/components/SessionDock";
import SyncStarter from "@/components/SyncStarter";
import SyncBoot from '@/components/SyncBoot';
import '@/lib/offlineSync';

export const metadata = {
  title: "TEPIHA",
  manifest: "/manifest.json",
};

export const viewport = {
  themeColor: "#0b0f14",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="sq">
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body>
        <ServiceWorkerRegister />
        <SyncStarter />
        <AuthGate>
          <SyncBoot />
        {children}
          <SessionDock />
        </AuthGate>
      </body>
    </html>
  );
}