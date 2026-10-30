import { NEW_STYLE_DATA } from "./design-schemes-new-styles";

export const STYLE_TEMPLATE_VERSION = "interior-styles-v3";

export type StyleMaterials = { walls: readonly string[]; floors: readonly string[]; ceilings: readonly string[]; windows: readonly string[]; furniture: readonly string[]; lighting: readonly string[]; textiles: readonly string[]; decor: readonly string[] };
export type ConcreteSpaceType = "living-room" | "corridor" | "children-room" | "bedroom" | "dining-room" | "kitchen" | "bathroom" | "study";
export type RoomFurniture = Record<Exclude<ConcreteSpaceType, "children-room">, readonly string[]> & Partial<Record<"children-room", readonly string[]>>;

export interface StylePreset {
  id: string;
  name: string;
  description: string;
  preview: string;
  /** Internal model instruction. Never return this field from a public API. */
  promptDirective: string;
  materials?: StyleMaterials;
  roomFurniture?: RoomFurniture;
}

export interface PublicStylePreset {
  id: string;
  name: string;
  description: string;
  preview?: string;
}

export const STYLE_PRESETS: readonly StylePreset[] = [
  {
    id: "modern-minimalist",
    name: "现代简约",
    description: "干净线条、克制配色与实用收纳，适合多数城市住宅。",
    preview: "/style-previews/modern-minimalist.webp",
    materials: { walls: ["warm white paint", "fine microcement", "light oak slats"], floors: ["pale oak", "large matte porcelain", "warm terrazzo"], ceilings: ["smooth white", "shadow-gap white", "light oak detail"], windows: ["slim white aluminum", "light oak trim", "minimal roller shade"], furniture: ["low modular sofa", "built-in storage", "simple oak table"], lighting: ["linear ceiling light", "slim track light", "paper globe pendant"], textiles: ["plain linen", "wool rug", "sheer white curtain"], decor: ["one ceramic vessel", "small leafy plant", "restrained artwork"] },
    roomFurniture: { "living-room": ["low modular sofa", "slim oak coffee table", "flush media cabinet"], corridor: ["floating entry console", "closed shoe cabinet", "slim bench"], bedroom: ["low upholstered platform bed", "slim oak platform bed", "floating-frame bed", "floating oak bedside tables", "full-height flush wardrobe", "paired minimal bedside lamps"], "dining-room": ["simple oak dining table", "slim upholstered dining chairs", "flush sideboard"], kitchen: ["handleless base cabinets", "integrated island", "concealed appliance wall"], bathroom: ["floating vanity", "frameless shower screen", "recessed storage"], study: ["light oak desk", "ergonomic chair", "flush bookcase"] },
    promptDirective:
      "Modern minimalist interior with clean architectural lines, restrained neutral colors, integrated storage, and uncluttered functional furniture.",
  },
  {
    id: "cream-cozy",
    name: "奶油风",
    description: "柔和米白、圆润家具与温暖材质，营造轻松柔软的居住感。",
    preview: "/style-previews/cream-cozy.webp",
    materials: { walls: ["warm ivory paint", "rounded plaster", "soft beige limewash"], floors: ["light oak", "warm stone", "cream terrazzo"], ceilings: ["ivory smooth", "soft cove", "warm white"], windows: ["cream aluminum", "oak trim", "linen roman shade"], furniture: ["rounded boucle sofa", "curved lounge chair", "soft wood table"], lighting: ["opal globe pendant", "curved floor lamp", "concealed cove light"], textiles: ["boucle", "washed linen", "cream wool"], decor: ["dried branch", "rounded ceramic", "small olive tree"] },
    roomFurniture: { "living-room": ["rounded boucle sofa", "soft-edge coffee table", "curved accent chair"], corridor: ["rounded shoe cabinet", "padded bench", "arched console"], bedroom: ["rounded boucle bed", "curved upholstered bed", "low ivory platform bed", "oval bedside tables", "cream wardrobe with curved corners", "opal bedside lamps"], "dining-room": ["oval travertine dining table", "boucle dining chairs", "rounded sideboard"], kitchen: ["ivory rounded cabinets", "soft-edge island", "built-in pantry"], bathroom: ["curved cream vanity", "rounded mirror cabinet", "arched shower screen"], study: ["rounded wood desk", "soft upholstered chair", "cream storage shelves"] },
    promptDirective:
      "Warm cream-style interior with soft ivory and beige tones, rounded furniture, tactile fabrics, and gentle layered lighting.",
  },
  {
    id: "wabi-sabi",
    name: "侘寂风",
    description: "自然肌理、低饱和色彩和留白，强调安静与时间感。",
    preview: "/style-previews/wabi-sabi.webp",
    materials: { walls: ["sealed mineral plaster", "warm clay plaster", "designed concrete"], floors: ["oak plank", "natural stone", "matte clay tile"], ceilings: ["quiet plaster", "timber slat", "warm white"], windows: ["dark oak frame", "slim bronze frame", "linen screen"], furniture: ["low linen sofa", "rough oak bench", "handcrafted cabinet"], lighting: ["soft paper lantern", "stone table lamp", "hidden warm wash"], textiles: ["raw linen", "handwoven wool", "natural cotton"], decor: ["branch arrangement", "unglazed pottery", "single sculptural stone"] },
    roomFurniture: { "living-room": ["low linen sofa", "rough oak coffee table", "handcrafted lounge chair"], corridor: ["weathered oak bench", "narrow plaster console", "simple storage chest"], bedroom: ["low solid-wood platform bed", "linen futon platform bed", "sculptural oak bed", "handcrafted bedside stools", "plain oak wardrobe", "paper bedside lanterns"], "dining-room": ["solid oak dining table", "woven dining chairs", "quiet timber sideboard"], kitchen: ["natural oak cabinets", "stone preparation counter", "open pottery shelf"], bathroom: ["stone basin vanity", "oak towel cabinet", "simple walk-in shower"], study: ["solid oak writing desk", "woven chair", "open timber bookcase"] },
    promptDirective:
      "Quiet wabi-sabi interior with natural plaster, aged wood, muted earth tones, imperfect organic textures, and generous negative space.",
  },
  {
    id: "italian-minimalist",
    name: "意式极简",
    description: "利落比例、深浅材质对比与精致细节，整体沉稳高级。",
    preview: "/style-previews/italian-minimalist.webp",
    materials: { walls: ["warm white plaster", "veined stone panel", "taupe paint"], floors: ["large limestone", "dark oak", "matte travertine"], ceilings: ["clean white", "shadow-gap", "slim timber detail"], windows: ["bronze aluminum", "dark oak", "sheer motorized shade"], furniture: ["sculptural sofa", "leather lounge chair", "stone coffee table"], lighting: ["sculptural pendant", "architectural track", "brass wall light"], textiles: ["fine wool", "leather", "neutral linen"], decor: ["abstract sculpture", "single branch", "stone vessel"] },
    roomFurniture: { "living-room": ["sculptural low sofa", "travertine coffee table", "leather lounge chair"], corridor: ["slim stone console", "dark-wood storage wall", "leather bench"], bedroom: ["tailored leather platform bed", "walnut platform bed", "floating upholstered bed", "dark-wood bedside cabinets", "flush walnut wardrobe", "slim brass bedside lights"], "dining-room": ["stone-top dining table", "leather dining chairs", "dark-wood sideboard"], kitchen: ["flush walnut cabinets", "travertine island", "integrated tall appliance wall"], bathroom: ["travertine floating vanity", "bronze-framed shower screen", "flush linen cabinet"], study: ["dark-wood executive desk", "leather chair", "integrated bookshelf"] },
    promptDirective:
      "Refined Italian minimalist interior with precise proportions, dark and light material contrast, elegant stone, leather accents, and sculptural lighting.",
  },
  {
    id: "contemporary-luxury",
    name: "现代轻奢",
    description: "现代空间中加入石材、金属与精致灯光，华丽但不过度。",
    preview: "/style-previews/contemporary-luxury.webp",
    materials: { walls: ["silk-finish taupe", "stone feature wall", "warm greige"], floors: ["large porcelain stone", "smoked oak", "light marble"], ceilings: ["smooth with cove", "white recessed", "subtle metal trim"], windows: ["bronze frame", "dark aluminum", "tailored drapery"], furniture: ["tailored sofa", "velvet accent chair", "stone console"], lighting: ["brass chandelier", "recessed spots", "sculptural floor lamp"], textiles: ["velvet", "silk-look drape", "plush wool"], decor: ["metallic vessel", "orchid", "small art object"] },
    roomFurniture: { "living-room": ["tailored velvet sofa", "marble coffee table", "metal-trimmed media cabinet"], corridor: ["stone-and-brass console", "upholstered bench", "flush display cabinet"], bedroom: ["padded velvet bed", "leather upholstered bed", "fluted-headboard bed", "marble-topped bedside tables", "metal-trimmed wardrobe", "brass bedside wall lamps"], "dining-room": ["marble dining table", "upholstered dining chairs", "brass-detailed sideboard"], kitchen: ["lacquered cabinets", "stone waterfall island", "integrated glass display unit"], bathroom: ["marble vanity", "framed glass shower", "backlit storage cabinet"], study: ["stone-and-wood desk", "upholstered chair", "metal-trimmed bookcase"] },
    promptDirective:
      "Contemporary light-luxury interior with tasteful stone, subtle metal details, polished joinery, sophisticated textiles, and elegant ambient lighting.",
  },
  {
    id: "nordic-natural",
    name: "北欧自然",
    description: "浅木、明亮空间和简洁家具，轻盈且强调日常舒适。",
    preview: "/style-previews/nordic-natural.webp",
    materials: { walls: ["soft white", "pale sage", "light wood panel"], floors: ["pale oak", "whitewashed oak", "light stone"], ceilings: ["matte white", "pale timber", "soft cove"], windows: ["white oak", "white aluminum", "sheer linen"], furniture: ["light fabric sofa", "oak dining table", "woven lounge chair"], lighting: ["simple pendant", "paper floor lamp", "diffuse ceiling light"], textiles: ["linen", "knit wool", "cotton canvas"], decor: ["green plant", "woven basket", "small ceramic"] },
    roomFurniture: { "living-room": ["light fabric sofa", "pale oak coffee table", "woven lounge chair"], corridor: ["birch shoe cabinet", "woven-seat bench", "slim wall shelf"], bedroom: ["pale oak platform bed", "birch slat bed", "linen upholstered bed", "simple birch bedside tables", "white-oak wardrobe", "paper bedside lamps"], "dining-room": ["pale oak dining table", "light wood chairs", "white sideboard"], kitchen: ["light birch cabinets", "oak breakfast island", "open utility shelves"], bathroom: ["light oak floating vanity", "simple glass shower", "white linen cabinet"], study: ["pale oak desk", "woven desk chair", "open birch bookcase"] },
    promptDirective:
      "Bright Nordic natural interior with pale timber, simple functional furniture, soft textiles, airy spacing, and abundant diffuse daylight.",
  },
  {
    id: "new-chinese",
    name: "新中式",
    description: "现代比例结合东方木作、留白与含蓄色彩。",
    preview: "/style-previews/new-chinese.webp",
    materials: { walls: ["warm rice paper tone", "quiet plaster", "restrained walnut accent panels"], floors: ["natural oak", "dark timber", "matte stone"], ceilings: ["white plaster", "thin walnut trim", "recessed dark detail"], windows: ["clear glass with slim dark-bronze frames", "clear glass with slim warm-gray aluminum frames", "tailored sheer curtains"], furniture: ["clean upholstered timber sofa", "low tea table", "contemporary lounge chair"], lighting: ["low-profile sculptural linear ceiling light", "concealed wash", "modern bronze floor lamp"], textiles: ["silk blend", "linen", "woven cotton"], decor: ["modern ink-inspired abstract artwork", "minimal ceramic vessel", "fresh branch arrangement"] },
    roomFurniture: { "living-room": ["contemporary upholstered walnut sofa", "slim walnut tea table", "flush media console", "modern upholstered lounge chair", "slim sofa-side table"], corridor: ["slim walnut entry cabinet", "carved-free timber bench", "quiet display shelf"], bedroom: ["low walnut platform bed", "contemporary walnut-frame bed", "upholstered timber bed", "matching walnut bedside cabinets", "plain-panel walnut wardrobe", "matching pair of refined bedside lamps"], "dining-room": ["solid walnut dining table", "woven-seat timber chairs", "slatted sideboard"], kitchen: ["dark timber flat-panel cabinets", "matte stone preparation island", "concealed appliance wall"], bathroom: ["dark timber vanity", "stone basin", "slim glazed shower"], study: ["solid-wood writing desk", "Ming-inspired armchair", "open timber bookshelves"] },
    promptDirective:
      "Contemporary new-Chinese interior combining modern proportions with refined timber joinery, restrained Eastern motifs, balanced symmetry, and calm negative space.",
  },
  {
    id: "mid-century-modern",
    name: "中古现代",
    description: "温润木色、经典家具轮廓和复古色彩，富有生活气息。",
    preview: "/style-previews/mid-century-modern.webp",
    materials: { walls: ["muted olive paint", "warm cream", "walnut panel"], floors: ["walnut", "honey oak", "terrazzo"], ceilings: ["matte cream", "wood beam detail", "warm white"], windows: ["walnut frame", "slim black frame", "woven shade"], furniture: ["walnut credenza", "low lounge sofa", "classic lounge chair"], lighting: ["sputnik pendant", "arc floor lamp", "ceramic table lamp"], textiles: ["geometric wool", "mustard linen", "leather"], decor: ["ceramic vase", "leafy plant", "abstract object"] },
    roomFurniture: { "living-room": ["low walnut-frame sofa", "kidney-shaped coffee table", "vintage walnut credenza"], corridor: ["tapered-leg console", "walnut bench", "vintage shoe cabinet"], bedroom: ["walnut spindle bed", "teak platform bed", "upholstered vintage bed", "tapered-leg bedside tables", "flat-panel walnut wardrobe", "ceramic bedside lamps"], "dining-room": ["oval walnut dining table", "moulded dining chairs", "vintage teak sideboard"], kitchen: ["walnut-faced cabinets", "terrazzo island", "open teak shelves"], bathroom: ["walnut vanity", "terrazzo basin", "simple glass shower"], study: ["vintage teak desk", "moulded desk chair", "walnut modular shelving"] },
    promptDirective:
      "Mid-century modern interior with warm walnut, iconic low-profile furniture, muted vintage colors, geometric accents, and inviting practical styling.",
  },
  {
    id: "japandi",
    name: "日式北欧",
    description: "日式克制与北欧舒适结合，强调浅木、留白和自然触感。",
    preview: "/style-previews/japandi.webp",
    materials: { walls: ["warm white", "pale clay", "light timber"], floors: ["pale oak", "bamboo", "matte stone"], ceilings: ["white plaster", "light timber", "soft recessed"], windows: ["oak frame", "white wood", "woven screen"], furniture: ["low platform sofa", "simple oak table", "woven bench"], lighting: ["paper pendant", "wash light", "minimal floor lamp"], textiles: ["linen", "wool", "cotton canvas"], decor: ["branch vase", "small fern", "handmade pottery"] },
    roomFurniture: { "living-room": ["low oak-frame sofa", "minimal pale-oak coffee table", "woven lounge chair"], corridor: ["pale-oak entry bench", "slim closed shoe storage", "woven wall shelf"], bedroom: ["low pale-oak platform bed", "tatami-inspired bed", "simple linen bed", "oak bedside shelves", "flat-front light-wood wardrobe", "paper bedside lamps"], "dining-room": ["light-oak dining table", "woven-seat dining chairs", "minimal timber sideboard"], kitchen: ["pale timber cabinets", "compact stone island", "simple open shelves"], bathroom: ["pale oak vanity", "stone basin", "clear walk-in shower"], study: ["light-oak writing desk", "woven chair", "open timber bookcase"] },
    promptDirective:
      "Calm Japandi interior combining Japanese restraint with Nordic comfort, pale natural timber, tactile neutral fabrics, low furniture, and uncluttered breathing room.",
  },
  {
    id: "french-modern",
    name: "法式现代",
    description: "简化法式线条与现代家具结合，优雅、明亮且不过度装饰。",
    preview: "/style-previews/french-modern.webp",
    materials: { walls: ["soft white paneling", "pale plaster", "light greige"], floors: ["chevron oak", "pale oak", "limestone"], ceilings: ["ornamental restrained", "smooth white", "slim cove"], windows: ["cream French frame", "slim bronze", "tailored linen"], furniture: ["curved sofa", "upholstered chair", "pale wood console"], lighting: ["glass pendant", "pleated floor lamp", "brass wall light"], textiles: ["linen", "boucle", "soft wool"], decor: ["fresh flowers", "small mirror", "ceramic vase"] },
    roomFurniture: { "living-room": ["curved linen sofa", "oval marble coffee table", "fluted pale-wood media cabinet"], corridor: ["slim marble console", "upholstered bench", "moulded storage cabinet"], bedroom: ["padded linen bed", "curved upholstered bed", "low fluted-oak bed", "fluted bedside tables", "panel-door wardrobe", "brass bedside sconces"], "dining-room": ["oval pale-oak dining table", "upholstered dining chairs", "fluted sideboard"], kitchen: ["cream panel-front cabinets", "pale stone island", "integrated pantry wall"], bathroom: ["fluted pale-wood vanity", "marble basin", "clear framed shower"], study: ["pale-oak writing desk", "upholstered desk chair", "moulded bookcase"] },
    promptDirective:
      "Modern French interior with restrained wall moulding, graceful proportions, light stone and oak, contemporary curved furniture, and understated refined detailing.",
  },
  {
    id: "industrial-loft",
    name: "工业风",
    description: "保留混凝土、金属和深色木材质感，空间利落而富有层次。",
    preview: "/style-previews/industrial-loft.webp",
    materials: { walls: ["sealed concrete", "mineral grey plaster", "dark brick accent"], floors: ["smoked oak", "sealed concrete", "slate tile"], ceilings: ["sealed concrete", "black track grid", "dark timber"], windows: ["black steel frame", "industrial aluminum", "mesh safety screen"], furniture: ["leather sofa", "steel shelving", "reclaimed wood table"], lighting: ["black track lights", "metal pendant", "cage floor lamp"], textiles: ["canvas", "leather", "flatweave wool"], decor: ["potted tree", "ceramic vessel", "minimal object"] },
    roomFurniture: { "living-room": ["worn leather sofa", "reclaimed-wood coffee table", "black-steel media shelf"], corridor: ["steel-frame console", "reclaimed-wood bench", "metal locker storage"], bedroom: ["black-steel platform bed", "reclaimed-oak bed", "leather-headboard bed", "reclaimed-wood bedside cabinets", "dark metal wardrobe", "cage bedside lamps"], "dining-room": ["reclaimed-wood dining table", "black-steel dining chairs", "metal sideboard"], kitchen: ["charcoal metal cabinets", "sealed concrete island", "open steel shelving"], bathroom: ["black-steel vanity", "sealed-concrete basin", "clear industrial shower"], study: ["steel-frame timber desk", "leather task chair", "black metal shelving"] },
    promptDirective:
      "Refined industrial-loft interior with honest concrete, dark metal, reclaimed timber, disciplined exposed details, layered warm light, and comfortable contemporary furniture.",
  },
  {
    id: "coastal-relaxed",
    name: "海岸休闲",
    description: "清爽白色、浅木与亚麻质感，呈现自然通风的度假氛围。",
    preview: "/style-previews/coastal-relaxed.webp",
    materials: { walls: ["airy white", "sand plaster", "pale blue-grey"], floors: ["pale oak", "matte limestone", "washed timber"], ceilings: ["white beadboard", "smooth white", "light timber"], windows: ["white aluminum", "pale oak", "linen shade"], furniture: ["linen sofa", "rattan chair", "pale wood table"], lighting: ["woven pendant", "ceramic lamp", "soft ceiling light"], textiles: ["linen", "cotton", "jute"], decor: ["coastal greenery", "ceramic shell-free vessel", "woven basket"] },
    roomFurniture: { "living-room": ["white linen sofa", "washed-oak coffee table", "rattan lounge chair"], corridor: ["whitewashed entry console", "woven-seat bench", "pale timber shoe cabinet"], bedroom: ["washed-oak platform bed", "white spindle bed", "linen upholstered bed", "linen-covered bedside tables", "white slatted wardrobe", "ceramic bedside lamps"], "dining-room": ["washed-wood dining table", "rattan dining chairs", "white beadboard sideboard"], kitchen: ["white shaker cabinets", "pale stone island", "open washed-oak shelves"], bathroom: ["washed-oak vanity", "pale stone basin", "clear glass shower"], study: ["whitewashed desk", "rattan desk chair", "pale open bookcase"] },
    promptDirective:
      "Relaxed coastal interior with airy whites, pale oak, linen textures, muted sea-glass accents, soft daylight, and an elegant non-themed resort atmosphere.",
  },
  ...NEW_STYLE_DATA.map(({ id, name, description, promptDirective }) => ({ id, name, description, promptDirective, preview: `/style-previews/${id}.webp` })),
] as const;

export function getStylePreset(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((preset) => preset.id === id);
}

export function listPublicStylePresets(): PublicStylePreset[] {
  return STYLE_PRESETS.map(({ id, name, description, preview }) => ({
    id,
    name,
    description,
    preview,
  }));
}
