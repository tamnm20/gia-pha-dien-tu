import type { Metadata, Viewport } from "next";
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin', 'vietnamese'],
});

export const viewport: Viewport = {
  themeColor: "#92400e", // Màu thanh trạng thái trên điện thoại (màu Hổ phách/Amber hợp với sách)
};

export const metadata: Metadata = {
  title: "Gia Phả Điện Tử",
  description: "Ứng dụng quản lý gia phả dòng họ",
  manifest: "/manifest.json", // Trỏ đến file manifest
  icons :
    {
      icon: "/favicon.ico",
    }
  ,
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Gia Phả",
  },
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
