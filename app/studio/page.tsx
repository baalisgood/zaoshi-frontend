import type { Metadata } from "next";
import { InteriorStudio } from "@/components/studio/InteriorStudio";

export const metadata: Metadata = {
  title: "智能工作台",
  description: "上传现场照片，选择设计风格、光照与输出参数，生成用于沟通的概念效果图。",
};

export default function StudioPage() {
  return <InteriorStudio />;
}
