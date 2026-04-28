import type { Metadata } from "next";
import { Inter, Syne } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const syne = Syne({
  variable: "--font-syne",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "LILA — Junto",
  description: "Lending Intelligence and Loan Automation",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${inter.variable} ${syne.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-bg-base text-fg font-sans">
        {children}
      </body>
    </html>
  );
}
