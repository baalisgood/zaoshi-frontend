"use client";
/* eslint-disable @next/next/no-img-element -- mixed photography and local style references. */
import { useCallback, useEffect, useRef, useState } from "react";
import { listPublicGallery, type GalleryCategory, type GalleryItem } from "@/components/site/api";

const labels: Record<GalleryCategory, string> = { interior: "室内设计", landscape: "景观环境", architecture: "建筑外观" };
const sourceUrls = ["https://unsplash.com/s/photos/minimal-interior", "https://unsplash.com/s/photos/luxury-living-room", "https://unsplash.com/s/photos/wabi-sabi-interior", "https://unsplash.com/s/photos/open-plan-interior", "https://unsplash.com/photos/modern-courtyard-with-reflective-pool-and-greenery--Ip141SUveY", "https://unsplash.com/s/photos/garden-architecture", "https://unsplash.com/photos/people-gather-in-a-modern-plaza-with-fountains-and-greenery-_74TJsS2xps", "https://unsplash.com/photos/modern-courtyard-with-a-large-tree-and-sunlight-K8G2MG0_W0s", "https://unsplash.com/s/photos/modern-villa", "https://unsplash.com/s/photos/commercial-architecture", "https://unsplash.com/photos/aerial-view-of-a-circular-housing-development-with-canals-frgZY-t1Q7Y", "https://unsplash.com/photos/modern-architectural-plaza-with-a-large-circular-opening-MeS5Ce4x0tk"];
const rawDemo = [
  ["soft-minimal-living", "温润极简起居室", "interior", "浅木、微水泥与柔和自然光", "landscape", "photo-1600566753086-00f18fb6b3ea", "现代温润极简住宅客厅，保留开阔横向空间和落地窗比例，浅橡木、米灰微水泥、低重心模块沙发，上午柔和自然光，真实材质纹理，建筑摄影视角，克制陈设，高级但可居住。"],
  ["stone-lounge", "石材与低重心客厅", "interior", "中性色层次与连续景观窗", "tall", "photo-1600210492486-724fe5c67fb0", "当代雅致客厅，米灰石材背景墙，低重心家具与大面积留白，连续景观窗，傍晚前的自然漫射光，准确透视，细腻织物和石材反射，室内设计杂志摄影。"],
  ["wabi-sabi-room", "静谧侘寂空间", "interior", "原生肌理、弧面与漫射光", "portrait", "photo-1616486338812-3dadae4b4ace", "侘寂风起居空间，保留原始建筑尺度，暖灰矿物涂料、圆弧墙面、手工木家具，极少装饰，柔和天光从侧面进入，空气感与真实墙面肌理，安静克制。"],
  ["gallery-kitchen", "开放式连廊客厅", "interior", "楼梯、挑空与起居区连续展开", "wide", "photo-1600607687920-4e2a09cf159d", "开放式住宅起居空间，楼梯、连廊与客厅连续展开，深木格栅搭配浅色石材，清晨自然光，整洁但有生活感，广角建筑摄影，空间尺度与透视准确。"],
  ["green-courtyard", "镜面水院", "landscape", "水景、绿植与建筑围合出安静内庭", "tall", "photo-1757840355407-d0dd616c0f95", "现代城市内庭院，镜面水池、乔木与低矮绿植形成安静围合，石材步道连接室内外，柔和日光与水面反射，尺度克制，真实景观摄影。"],
  ["glass-garden", "玻璃花房与四季花园", "landscape", "建筑边界融入植物群落", "landscape", "photo-1585320806297-9794b3e4eeae", "当代玻璃花房嵌入四季花园，透明结构与茂密植物形成层次，石材小径引导视线，阴天柔光，建筑与景观一体化，真实细节，宁静且具有公共空间品质。"],
  ["resort-water", "城市公共水景广场", "landscape", "喷泉、绿地与人群共同形成活力界面", "wide", "photo-1768056088909-22a9159af2f7", "现代城市公共广场，线性喷泉、草坪与遮荫树共同组织人群活动，步行流线清晰，午后自然光，建筑界面简洁，公共空间真实使用场景。"],
  ["park-path", "树荫下的城市内庭", "landscape", "成熟乔木与光影成为空间主角", "portrait", "photo-1777620817586-f06aae288691", "现代城市建筑内庭，保留一株成熟大树作为中心，简洁铺装、可坐边界与少量绿植，阳光穿过树冠形成斑驳阴影，人本尺度，安静而有日常活力。"],
  ["modern-villa", "山地现代住宅", "architecture", "深色体块嵌入自然坡地", "landscape", "photo-1600585154340-be6161a56a0c", "山地现代独栋住宅，水平向深色体块嵌入自然坡地，大面积玻璃与悬挑屋面，保留周边成熟树木，傍晚室内暖光亮起，真实建筑摄影，结构与材料可信。"],
  ["commercial-facade", "城市商业立面", "architecture", "轻盈幕墙与有秩序的夜景", "tall", "photo-1486406146926-c627a92ad1ab", "当代城市商业建筑立面，通透玻璃幕墙与细密金属竖向构件，入口尺度明确，蓝调时刻，室内灯光有节奏地亮起，街道视角，专业建筑可视化品质。"],
  ["community-aerial", "低密社区鸟瞰", "architecture", "住宅组团、道路与水系整体推演", "wide", "photo-1776066361565-d0a6cac89c9b", "低密度住宅社区总体鸟瞰，建筑组团、道路系统、连续水系与宅间绿地关系清晰，午后阳光，开发商方案汇报风格，尺度准确，不过度戏剧化。"],
  ["civic-geometry", "公共建筑几何秩序", "architecture", "圆形开口组织城市广场与人流", "portrait", "photo-1760104894363-b3ea46fe5790", "当代公共建筑与城市广场，巨大圆形开口成为视觉中心，浅色结构、玻璃界面与步行人流形成清晰秩序，晴朗午后，真实透视和结构细节。"],
] as const;
const photography: GalleryItem[] = rawDemo.map(([id, title, category, note, shape, photo, prompt], index) => ({ id, title, category: category as GalleryCategory, note, prompt, source: sourceUrls[index], width: shape === "wide" ? 1500 : shape === "landscape" ? 1400 : shape === "tall" ? 1000 : 1100, height: shape === "wide" || shape === "landscape" ? 1000 : shape === "tall" ? 1400 : 1000, thumbUrl: `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=900&q=86`, displayUrl: `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=1500&q=86` }));
const localStyles: GalleryItem[] = [
  { id:"style-modern-minimalist",title:"现代简约风格示例",category:"interior",note:"干净线条、克制配色与实用收纳，适合多数城市住宅。",prompt:"现代简约室内设计，干净线条、克制配色与实用收纳，适合多数城市住宅。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/modern-minimalist.webp",displayUrl:"/style-previews/modern-minimalist.webp" },
  { id:"style-cream-cozy",title:"奶油风风格示例",category:"interior",note:"柔和米白、圆润家具与温暖材质，营造轻松柔软的居住感。",prompt:"奶油风室内设计，柔和米白、圆润家具与温暖材质，营造轻松柔软的居住感。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/cream-cozy.webp",displayUrl:"/style-previews/cream-cozy.webp" },
  { id:"style-wabi-sabi",title:"侘寂风风格示例",category:"interior",note:"自然肌理、低饱和色彩和留白，强调安静与时间感。",prompt:"侘寂风室内设计，自然肌理、低饱和色彩和留白，强调安静与时间感。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/wabi-sabi.webp",displayUrl:"/style-previews/wabi-sabi.webp" },
  { id:"style-italian-minimalist",title:"意式极简风格示例",category:"interior",note:"利落比例、深浅材质对比与精致细节，整体沉稳高级。",prompt:"意式极简室内设计，利落比例、深浅材质对比与精致细节，整体沉稳高级。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/italian-minimalist.webp",displayUrl:"/style-previews/italian-minimalist.webp" },
  { id:"style-contemporary-luxury",title:"现代轻奢风格示例",category:"interior",note:"现代空间中加入石材、金属与精致灯光，华丽但不过度。",prompt:"现代轻奢室内设计，现代空间中加入石材、金属与精致灯光，华丽但不过度。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/contemporary-luxury.webp",displayUrl:"/style-previews/contemporary-luxury.webp" },
  { id:"style-nordic-natural",title:"北欧自然风格示例",category:"interior",note:"浅木、明亮空间和简洁家具，轻盈且强调日常舒适。",prompt:"北欧自然室内设计，浅木、明亮空间和简洁家具，轻盈且强调日常舒适。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/nordic-natural.webp",displayUrl:"/style-previews/nordic-natural.webp" },
  { id:"style-new-chinese",title:"新中式风格示例",category:"interior",note:"现代比例结合东方木作、留白与含蓄色彩。",prompt:"新中式室内设计，现代比例结合东方木作、留白与含蓄色彩。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/new-chinese.webp",displayUrl:"/style-previews/new-chinese.webp" },
  { id:"style-mid-century-modern",title:"中古现代风格示例",category:"interior",note:"温润木色、经典家具轮廓和复古色彩，富有生活气息。",prompt:"中古现代室内设计，温润木色、经典家具轮廓和复古色彩，富有生活气息。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/mid-century-modern.webp",displayUrl:"/style-previews/mid-century-modern.webp" },
  { id:"style-japandi",title:"日式北欧风格示例",category:"interior",note:"日式克制与北欧舒适结合，强调浅木、留白和自然触感。",prompt:"日式北欧室内设计，日式克制与北欧舒适结合，强调浅木、留白和自然触感。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/japandi.webp",displayUrl:"/style-previews/japandi.webp" },
  { id:"style-french-modern",title:"法式现代风格示例",category:"interior",note:"简化法式线条与现代家具结合，优雅、明亮且不过度装饰。",prompt:"法式现代室内设计，简化法式线条与现代家具结合，优雅、明亮且不过度装饰。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/french-modern.webp",displayUrl:"/style-previews/french-modern.webp" },
  { id:"style-industrial-loft",title:"工业风风格示例",category:"interior",note:"保留混凝土、金属和深色木材质感，空间利落而富有层次。",prompt:"工业风室内设计，保留混凝土、金属和深色木材质感，空间利落而富有层次。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/industrial-loft.webp",displayUrl:"/style-previews/industrial-loft.webp" },
  { id:"style-coastal-relaxed",title:"海岸休闲风格示例",category:"interior",note:"清爽白色、浅木与亚麻质感，呈现自然通风的度假氛围。",prompt:"海岸休闲室内设计，清爽白色、浅木与亚麻质感，呈现自然通风的度假氛围。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:675,thumbUrl:"/style-previews/coastal-relaxed.webp",displayUrl:"/style-previews/coastal-relaxed.webp" },
  { id:"style-american-modern",title:"美式现代风格示例",category:"interior",note:"舒展家具、温暖木色与简洁线条的生活空间。",prompt:"美式现代室内设计，舒展家具、温暖木色与简洁线条的生活空间。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:507,thumbUrl:"/style-previews/american-modern.webp",displayUrl:"/style-previews/american-modern.webp" },
  { id:"style-american-traditional",title:"美式传统风格示例",category:"interior",note:"经典家具轮廓、沉稳木作与温馨层次。",prompt:"美式传统室内设计，经典家具轮廓、沉稳木作与温馨层次。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:507,thumbUrl:"/style-previews/american-traditional.webp",displayUrl:"/style-previews/american-traditional.webp" },
  { id:"style-art-deco",title:"装饰艺术风格示例",category:"interior",note:"几何秩序、精致金属与富有节奏的装饰表达。",prompt:"装饰艺术室内设计，几何秩序、精致金属与富有节奏的装饰表达。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:507,thumbUrl:"/style-previews/art-deco.webp",displayUrl:"/style-previews/art-deco.webp" },
  { id:"style-european-classical",title:"欧式古典风格示例",category:"interior",note:"经典线脚、对称布局与庄重的室内比例。",prompt:"欧式古典室内设计，经典线脚、对称布局与庄重的室内比例。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:507,thumbUrl:"/style-previews/european-classical.webp",displayUrl:"/style-previews/european-classical.webp" },
  { id:"style-traditional-chinese",title:"传统中式风格示例",category:"interior",note:"东方木作、传统家具与含蓄的空间秩序。",prompt:"传统中式室内设计，东方木作、传统家具与含蓄的空间秩序。保留可信空间尺度、材质细节和自然光照，作为概念设计方向。",width:900,height:507,thumbUrl:"/style-previews/traditional-chinese.webp",displayUrl:"/style-previews/traditional-chinese.webp" },
];
const photoOrder = [0,4,8,1,5,9,2,6,10,3,7,11];
const demo: GalleryItem[] = localStyles.flatMap((item,index) => index < photography.length ? [photography[photoOrder[index]],item] : [item]);
function ratio(item: GalleryItem) { const value = item.width / item.height; return value > 1.45 ? "wide" : value > 1.08 ? "landscape" : value < .8 ? "tall" : "portrait"; }

export function HomePage() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [source, setSource] = useState<"community" | "demo">("demo");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backdropPointerDownRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const loadingMoreRef = useRef(false);
  const hasCommunityRef = useRef<boolean | null>(null);
  const cursorRef = useRef<string | undefined>(undefined);
  const itemsRef = useRef(items);
  const stateRef = useRef(state);
  useEffect(() => { itemsRef.current = items; stateRef.current = state; cursorRef.current = cursor; }, [items, state, cursor]);
  const load = useCallback(async (reset: boolean) => {
    if (!reset && loadingMoreRef.current) return;
    const epoch = ++epochRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (reset) {
      loadingMoreRef.current = false;
      setState("loading");
      setItems([]);
      setCursor(undefined);
      setSource("demo");
    } else {
      loadingMoreRef.current = true;
    }
    setError("");
    try {
      const result = await listPublicGallery(
        undefined,
        reset ? undefined : cursorRef.current,
        controller.signal,
      );
      if (epoch !== epochRef.current) return;
      const old = itemsRef.current;
      const knownIds = new Set(old.map((item) => item.id));
      const next = reset ? result.items : [...old, ...result.items.filter((item) => !knownIds.has(item.id))];
      if (reset) hasCommunityRef.current = result.hasCommunity;
      setItems(next);
      setCursor(result.nextCursor);
      const shouldUseDemo = reset && result.items.length === 0;
      setSource(shouldUseDemo ? "demo" : "community");
      setState("ready");
    } catch (reason) {
      if (controller.signal.aborted || epoch !== epochRef.current) return;
      if (reset && hasCommunityRef.current === false) setSource("demo");
      setState("error");
      setError(
        reason instanceof Error ? reason.message : "图库暂时无法读取。",
      );
    } finally {
      if (epoch === epochRef.current) loadingMoreRef.current = false;
    }
  }, []);
  useEffect(() => {
    Promise.resolve().then(() => load(true));
    return () => abortRef.current?.abort();
  }, [load]);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || source !== "community") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          cursorRef.current &&
          stateRef.current === "ready" &&
          !loadingMoreRef.current
        ) {
          void load(false);
        }
      },
      { rootMargin: "500px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [load, source]);
  const visible = source === "demo" ? demo : items;
  const selected = visible.find(item => item.id === selectedId) ?? null;
  const related = selected ? visible.filter(item => item.category === selected.category && item.id !== selected.id).slice(0, 3) : [];
  useEffect(() => { const dialog = dialogRef.current; if (selected && dialog && !dialog.open) dialog.showModal(); if (!selected && dialog?.open) dialog.close(); }, [selected]);
  async function copyPrompt() { if (!selected?.prompt) return; try { await navigator.clipboard.writeText(selected.prompt); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); } }
  function isOutsideDetail(clientX: number, clientY: number) {
    const rect = dialogRef.current?.getBoundingClientRect();
    return !!rect && (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom);
  }
  function closeDetail() { backdropPointerDownRef.current = false; dialogRef.current?.close(); setSelectedId(null); setCopied(false); }
  return <div className="home-page gallery-home"><section className="gallery-intro page-shell"><div className="gallery-hero-copy"><span className="section-kicker">ZAOSHI DESIGN GALLERY</span><h1>懂设计，<br/><em>就能开始 AI 创作。</em></h1><p className="intro-subtitle">把室内设计提示词，变成可视化工作台。</p><div className="gallery-intro-copy"><p>上传现场照片，选择风格与方案配色，调整空间和光照。造室把你的设计选择组合成生成指令，让第一次使用 AI 的设计师容易开始，也让已有经验的设计师更高效地探索方案。</p><div className="gallery-actions"><a className="primary-button" href="/studio">开始一个设计</a><a className="secondary-link" href="/self-service">自由输入提示词 <span aria-hidden="true">→</span></a></div></div></div><div className="gallery-hero-media" aria-hidden="true"><img src="/style-previews/modern-minimalist.webp" alt="" width={900} height={675}/></div></section><section className="gallery-browser page-shell" aria-labelledby="gallery-title"><div className="gallery-toolbar"><div><h2 id="gallery-title">空间灵感库</h2><p>造室精选 · 摄影参考与造室风格示例 · 非客户案例 · 提示词为画面分析与设计方向建议</p></div></div>{state === "loading" && <div className="state-panel" role="status">正在读取图库…</div>}{state === "error" && <div className="state-panel error" role="alert"><strong>图库读取失败</strong><p>{error}</p><button type="button" onClick={() => void load(true)}>重试</button></div>}{state === "ready" && visible.length === 0 && <div className="state-panel" role="status">暂无作品。</div>}<div className="masonry-gallery" aria-live="polite">{visible.map(item => <article className={`gallery-card ratio-${ratio(item)}`} data-gallery-id={item.id} key={item.id}><button type="button" aria-label={`查看${item.title}的作品详情`} onClick={() => setSelectedId(item.id)}><img src={item.thumbUrl} alt={item.title} loading="lazy" width={item.width} height={item.height} /><span className="gallery-card-shade" aria-hidden="true" /><span className="gallery-card-meta"><small>{labels[item.category]}{source === "demo" ? item.id.startsWith("style-") ? " · 造室风格示例" : " · 摄影参考" : ""}</small><strong>{item.title}</strong><em>{item.note}</em></span><span className="gallery-card-open" aria-hidden="true">↗</span></button></article>)}</div><div ref={sentinelRef} className="gallery-sentinel" aria-hidden="true" />{state === "ready" && !cursor && visible.length > 0 && <p className="gallery-end">已展示全部作品</p>}</section>{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- Native modal handles keyboard dismissal through onCancel. */}
<dialog ref={dialogRef} className="gallery-dialog" aria-labelledby="gallery-detail-title" onPointerDown={event => { backdropPointerDownRef.current = event.isPrimary && event.button === 0 && event.target === event.currentTarget && isOutsideDetail(event.clientX, event.clientY); }} onPointerCancel={() => { backdropPointerDownRef.current = false; }} onClick={event => { const startedOutside = backdropPointerDownRef.current; backdropPointerDownRef.current = false; if (event.button === 0 && startedOutside && event.target === event.currentTarget && isOutsideDetail(event.clientX, event.clientY)) closeDetail(); }} onClose={() => { backdropPointerDownRef.current = false; }} onCancel={event => { event.preventDefault(); closeDetail(); }}>{selected && <div className="gallery-detail"><button className="gallery-detail-close" type="button" aria-label="关闭作品详情" onClick={closeDetail}>×</button><div className="gallery-detail-media"><img src={selected.displayUrl} alt={selected.title} width={selected.width} height={selected.height} /></div><div className="gallery-detail-copy"><span className="section-kicker">{labels[selected.category]}</span><h2 id="gallery-detail-title">{selected.title}</h2><p className="gallery-detail-note">{selected.note}</p><div className="gallery-detail-tags"><span>构图参考</span><span>材质参考</span><span>光照参考</span></div><section className="prompt-panel" aria-labelledby="prompt-title"><div><h3 id="prompt-title">{selected.prompt ? "构图分析提示词" : "造室设计方向"}</h3>{selected.prompt && <button type="button" onClick={() => void copyPrompt()}>{copied ? "已复制" : "复制提示词"}</button>}</div><p>{selected.prompt ?? "造室暂未提供设计方向"}</p><small><span>{selected.id.startsWith("style-") ? "造室风格示例，仅用于表达设计方向，非客户案例或真实施工成果。" : "这段文字由造室根据画面整理，用于辅助生成设计方向，并非该摄影作品的原始生成记录。"}</span> {selected.source && <a href={selected.source}>摄影素材来源</a>}</small></section><div className="gallery-detail-actions"><a className="primary-button" href="/studio">带着方向开始设计</a></div></div>{related.length > 0 && <section className="gallery-related" aria-labelledby="related-title"><div><h3 id="related-title">更多同类灵感</h3><span>{labels[selected.category]}</span></div><div>{related.map(item => <button key={item.id} type="button" onClick={() => { setCopied(false); setSelectedId(item.id); }}><img src={item.thumbUrl} alt="" loading="lazy" width={item.width} height={item.height} /><span>{item.title}</span></button>)}</div></section>}</div>}</dialog></div>;
}
