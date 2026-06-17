import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Meridian Recovery Services",
  description: "Resolve your account securely.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
