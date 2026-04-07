import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import NavBar from "./NavBar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Secure File Share",
  description: "Authenticated file upload with expiring download tokens.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <NavBar />
        {children}
        <footer className="mt-auto py-3 text-center">
          <span className="font-mono text-xs text-zinc-300 dark:text-zinc-700 select-none">
            rev: {process.env.NEXT_PUBLIC_COMMIT_SHA ?? 'dev'}
          </span>
        </footer>
      </body>
    </html>
  );
}
