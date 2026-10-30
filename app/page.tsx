import type { Metadata } from "next";
import { HomePage } from "@/components/home/HomePage";

export const metadata: Metadata = {
  title: "造室 · AI 空间设计灵感与工作台",
  description: "浏览室内、景观环境与建筑外观灵感，查看构图分析提示词，并进入造室 AI 设计工作台完成概念与精修。",
};

export default function Home() {
  return <HomePage />;
}
