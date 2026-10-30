import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { AppShell } from "@/components/site/AppShell";
import { readWechatAuthConfig } from "@/lib/server/wechat-auth-config";
import { readCookie } from "@/lib/server/actor";
import "./globals.css";

const title = "造室 · AI 室内设计工作台";
const description = "面向室内设计师的现场照片、概念效果图、结构控制和彩平表达工作台。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestedHost = forwardedHost || requestHeaders.get("host") || "";
  const host = /^[a-z0-9.-]+(?::\d+)?$/iu.test(requestedHost)
    ? requestedHost
    : "example.com";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const localHost = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/iu.test(host);
  const protocol = forwardedProtocol === "http" || (!forwardedProtocol && localHost) ? "http" : "https";
  const shareImage = new URL("/og.png", `${protocol}://${host}`).toString();

  return {
    title: {
      default: title,
      template: "%s · 造室",
    },
    description,
    icons: {
      icon: [{ url:"/favicon.ico", sizes:"16x16 32x32", type:"image/x-icon" }, { url:"/favicon.svg", type:"image/svg+xml" }, { url:"/icon-192.png", sizes:"192x192", type:"image/png" }, { url:"/icon-512.png", sizes:"512x512", type:"image/png" }],
      shortcut: "/favicon.ico",
      apple: [{ url:"/apple-touch-icon.png", sizes:"180x180", type:"image/png" }],
    },
    openGraph: {
      type: "website",
      locale: "zh_CN",
      title,
      description,
      images: [{ url: shareImage, width: 1200, height: 630, alt: "造室 AI 室内设计工作台" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [shareImage],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let initialEmailEntry = false;
  try {
    const requestHeaders = await headers();
    const emailMode = process.env.ZAOSHI_RUNTIME === "node" ? process.env.AUTH_MODE === "email" : readWechatAuthConfig().mode === "email";
    initialEmailEntry = emailMode && !readCookie(requestHeaders.get("cookie"), "__Host-zaoshi_session");
  } catch { /* Identity remains pending; the account rail keeps its width. */ }
  return (
    <html lang="zh-CN">
      <body><AppShell initialEmailEntry={initialEmailEntry}>{children}</AppShell></body>
    </html>
  );
}
