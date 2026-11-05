import type { Metadata } from 'next';
import { themeBootScript } from './lib/theme';
import { Fira_Code, Fira_Sans } from 'next/font/google';
import './globals.css';

const firaSans = Fira_Sans({
  subsets: ['latin', 'vietnamese'], weight: ['400', '500', '600'], variable: '--font-fira-sans', display: 'swap',
});
const firaCode = Fira_Code({
  subsets: ['latin'], weight: ['400', '500'], variable: '--font-fira-code', display: 'swap',
});

export const metadata: Metadata = { title: 'Agent CCTV', description: 'Theo dõi trực tiếp các agent Claude Code và Codex' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`${firaSans.variable} ${firaCode.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootScript() }} /></head>
      <body>{children}</body>
    </html>
  );
}
