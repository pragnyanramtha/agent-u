import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-face" });

export const metadata: Metadata = {
  title: "agent-u",
  description: "Your coding agents, from any screen.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "agent-u", statusBarStyle: "black-translucent" },
  robots: { index: false, follow: false },
};

/* Browser chrome color per theme, matched to --page. Keep in sync with ThemeToggle. */
const THEME_COLOR = { dark: "#17181a", light: "#fafafb" };

/* theme-color is rendered by hand (below) instead of through `viewport`, so it
 * follows the app's own theme choice rather than the OS color scheme. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

/* Dark by default; the stored choice is applied before paint so there's no flash,
 * and the browser chrome color is matched to it. */
const themeScript = `(function(){var d=true;try{d=localStorage.getItem("bui-theme")!=="light"}catch(e){}document.documentElement.classList.toggle("dark",d);var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",d?"${THEME_COLOR.dark}":"${THEME_COLOR.light}")})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content={THEME_COLOR.dark} suppressHydrationWarning />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${inter.variable} ${mono.variable} font-sans`}>{children}</body>
    </html>
  );
}
