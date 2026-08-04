// import type { NextConfig } from "next";

// const nextConfig: NextConfig = {
//   /* config options here */
// };

// export default nextConfig;

import withPWAInit from "@ducanh2912/next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development", // Tắt PWA khi đang code để tránh lỗi cache, chỉ bật khi build production
  register: true,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ... các cấu hình hiện tại của bạn giữ nguyên ở đây
  reactStrictMode: true,
};

export default withPWA(nextConfig);
