import { V2_RECIPES } from "./design-schemes-v2";
import { V8_RECIPES } from "./design-schemes-v8";
import { V9_CEILINGS } from "./design-schemes-v9";
import { NEW_SCHEME_DATA } from "./design-schemes-new-styles";

// Astra-authored immutable v1 recipes. Add new IDs instead of editing released recipes.
export const DESIGN_SCHEME_CATALOG_VERSION = "design-schemes-v11";
export type DesignScheme = { id: string; styleId: string; name: string; description: string; palette: readonly [string, string, string]; paletteDirection?: string; portableLighting?: string; compact?: string; compactCeiling?: string; livingCeiling?: string; walls: string; floor: string; ceiling: string; furniture: string; lighting: string; textiles: string; decor: string; wet: string };
const SCHEMES: readonly DesignScheme[] = [
  {
    "id": "modern-minimalist-01-v1",
    "styleId": "modern-minimalist",
    "name": "暖白浅木",
    "description": "暖白、浅橡木与轻盈直线",
    "palette": [
      "#F1EDE4",
      "#CDB38E",
      "#787970"
    ],
    "walls": "warm-white matte paint",
    "floor": "pale natural oak planks",
    "ceiling": "flat warm-white ceiling",
    "furniture": "slim oak frames and low ivory upholstery",
    "lighting": "thin white linear main fixture with small opal task lamps",
    "textiles": "oatmeal linen and flatweave wool",
    "decor": "off-white ceramics and one green branch",
    "wet": "warm-white fine gray-veined porcelain"
  },
  {
    "id": "modern-minimalist-02-v1",
    "styleId": "modern-minimalist",
    "name": "石灰静界",
    "description": "石灰色、微水泥与低矮体块",
    "palette": [
      "#D5D2C9",
      "#A6A59F",
      "#626864"
    ],
    "walls": "fine sealed pale-gray mineral plaster",
    "floor": "large matte greige porcelain",
    "ceiling": "seamless light-gray ceiling",
    "furniture": "low rounded gray upholstery and honed stone accents",
    "lighting": "shallow disk main light with brushed-steel task lamps",
    "textiles": "stone-gray wool and natural linen",
    "decor": "dark stone vessel and restrained monochrome art",
    "wet": "pale-gray cloud-veined porcelain"
  },
  {
    "id": "modern-minimalist-03-v1",
    "styleId": "modern-minimalist",
    "name": "黑白序列",
    "description": "柔白、炭黑与清晰线条",
    "palette": [
      "#F3F1E9",
      "#343738",
      "#B7AA96"
    ],
    "walls": "soft-white paint with a limited charcoal panel",
    "floor": "pale matte limestone-look porcelain",
    "ceiling": "flat white ceiling with thin dark shadow gaps",
    "furniture": "ivory planar upholstery with slim black metal frames",
    "lighting": "black linear main fixture and white opal task lamps",
    "textiles": "ivory canvas with small charcoal accents",
    "decor": "black ceramic vessel and linear abstract art",
    "wet": "white porcelain with restrained charcoal veins"
  },
  {
    "id": "modern-minimalist-04-v1",
    "styleId": "modern-minimalist",
    "name": "暖灰胡桃",
    "description": "暖灰、胡桃木与沉稳比例",
    "palette": [
      "#D6CEC2",
      "#795A43",
      "#EAE5DC"
    ],
    "walls": "warm-gray matte paint with restrained walnut joinery",
    "floor": "medium walnut planks",
    "ceiling": "smooth warm-white ceiling",
    "furniture": "tailored greige upholstery and precise walnut storage",
    "lighting": "bronze low-profile main light and linen-shaded task lamps",
    "textiles": "taupe linen and oatmeal wool",
    "decor": "amber glass and a dark ceramic bowl",
    "wet": "warm-gray fine brown-veined porcelain"
  },
  {
    "id": "modern-minimalist-05-v1",
    "styleId": "modern-minimalist",
    "name": "雾绿微光",
    "description": "雾绿、白蜡木与柔和层次",
    "palette": [
      "#B4BCAF",
      "#D7C6A8",
      "#EEECE3"
    ],
    "walls": "muted sage paint balanced with warm white",
    "floor": "pale ash-toned oak planks",
    "ceiling": "flat off-white ceiling",
    "furniture": "light ash frames and warm-white upholstery",
    "lighting": "soft opal main fixture and sage metal task lamps",
    "textiles": "unbleached linen with muted green cushions",
    "decor": "pale ceramic vessels and botanical art",
    "wet": "pale-sage-gray delicate white-veined porcelain"
  },
  {
    "id": "modern-minimalist-06-v1",
    "styleId": "modern-minimalist",
    "name": "陶土素境",
    "description": "米白、陶土与自然暖色",
    "palette": [
      "#E8DFD0",
      "#B97B61",
      "#B69A74"
    ],
    "walls": "warm-ivory paint with a restrained clay-colored accent",
    "floor": "natural honey-oak planks",
    "ceiling": "flat ivory ceiling",
    "furniture": "clean oak profiles and sand upholstery",
    "lighting": "sand-colored disk main light with simple ceramic task lamps",
    "textiles": "natural cotton and clay-toned woven accents",
    "decor": "terracotta bowl and warm abstract art",
    "wet": "warm-beige fine amber-veined porcelain"
  },
  {
    "id": "cream-cozy-01-v1",
    "styleId": "cream-cozy",
    "name": "云朵奶霜",
    "description": "奶白、绒感织物与柔圆轮廓",
    "palette": [
      "#F3EBDD",
      "#DED0BB",
      "#C2AD91"
    ],
    "walls": "smooth warm-ivory plaster",
    "floor": "pale oak planks",
    "ceiling": "soft ivory ceiling",
    "furniture": "rounded ivory boucle upholstery and pale-oak capsule edges",
    "lighting": "opal globe main light and curved cream task lamps",
    "textiles": "cream boucle and ivory wool",
    "decor": "rounded matte ceramics and fresh white flowers",
    "wet": "ivory soft gold-veined porcelain"
  },
  {
    "id": "cream-cozy-02-v1",
    "styleId": "cream-cozy",
    "name": "燕麦拿铁",
    "description": "燕麦、浅咖与温润木色",
    "palette": [
      "#D8C8B0",
      "#AA8B6E",
      "#F0E7D8"
    ],
    "walls": "oatmeal limewash",
    "floor": "warm light-oak planks",
    "ceiling": "matte cream ceiling",
    "furniture": "low oatmeal linen upholstery and caramel-oak frames",
    "lighting": "cream drum main fixture and mushroom task lamps",
    "textiles": "oatmeal linen and camel wool",
    "decor": "sand pottery and dried grasses",
    "wet": "warm-beige soft brown-veined porcelain"
  },
  {
    "id": "cream-cozy-03-v1",
    "styleId": "cream-cozy",
    "name": "蜜桃奶杏",
    "description": "奶杏、浅桃与细腻弧线",
    "palette": [
      "#EACFBA",
      "#DCA996",
      "#F1E9DA"
    ],
    "walls": "pale apricot mineral paint",
    "floor": "cream matte stone-look porcelain",
    "ceiling": "soft warm-white ceiling",
    "furniture": "soft curved ivory upholstery with pale-peach accents",
    "lighting": "petal-like opal main fixture and small ivory ceramic lamps",
    "textiles": "washed ivory cotton and dusty-peach linen",
    "decor": "blush ceramic vessel and loose floral stems",
    "wet": "pale-apricot fine cream-veined porcelain"
  },
  {
    "id": "cream-cozy-04-v1",
    "styleId": "cream-cozy",
    "name": "香草浅木",
    "description": "香草白、浅木与清爽留白",
    "palette": [
      "#EBE6D4",
      "#C7B68F",
      "#C0C5AF"
    ],
    "walls": "vanilla-white matte paint",
    "floor": "light ash-toned oak planks",
    "ceiling": "flat vanilla-white ceiling",
    "furniture": "rounded pale timber frames and smooth cream cotton upholstery",
    "lighting": "pale-wood rimmed main light and frosted-glass task lamps",
    "textiles": "natural cotton and faint sage linen",
    "decor": "light wood bowl and small leafy plant",
    "wet": "vanilla-white sparse beige-veined porcelain"
  },
  {
    "id": "cream-cozy-05-v1",
    "styleId": "cream-cozy",
    "name": "榛果柔光",
    "description": "榛果木、米灰与丰厚织物",
    "palette": [
      "#C3A487",
      "#E6DACC",
      "#8F7662"
    ],
    "walls": "warm beige plaster",
    "floor": "light hazelnut-oak planks",
    "ceiling": "ivory ceiling with a shallow perimeter recess",
    "furniture": "rounded warm-gray upholstery and solid hazelnut wood",
    "lighting": "low-profile cream main fixture and bronze-stem fabric lamps",
    "textiles": "beige wool and caramel linen",
    "decor": "cocoa ceramic vessels and textured neutral art",
    "wet": "light-hazelnut fine ivory-veined porcelain"
  },
  {
    "id": "cream-cozy-06-v1",
    "styleId": "cream-cozy",
    "name": "月白珍珠",
    "description": "月白、珍珠灰与细哑金属",
    "palette": [
      "#EEECE5",
      "#C9CAC5",
      "#A8A297"
    ],
    "walls": "pearl-white matte paint",
    "floor": "pale greige matte porcelain",
    "ceiling": "smooth pearl-white ceiling",
    "furniture": "pearl-gray curved upholstery and pale ash storage",
    "lighting": "frosted-glass main fixture with satin-nickel task lamps",
    "textiles": "pearl-gray linen and ivory soft wool",
    "decor": "translucent glass and white sculptural pottery",
    "wet": "pearl-gray delicate white-veined porcelain"
  },
  {
    "id": "wabi-sabi-01-v1",
    "styleId": "wabi-sabi",
    "name": "沙岩静境",
    "description": "沙色矿物、浅石与粗织亚麻",
    "palette": [
      "#D7C4A7",
      "#B2A28C",
      "#ECE4D5"
    ],
    "walls": "finished sealed sand mineral plaster",
    "floor": "honed sand-stone-look porcelain",
    "ceiling": "smooth warm mineral ceiling",
    "furniture": "low sand-linen upholstery and solid pale-oak slabs",
    "lighting": "flattened handmade-paper main fixture and stone task lamps",
    "textiles": "raw linen and coarse natural wool",
    "decor": "unglazed sand pottery and a single branch",
    "wet": "warm-sand muted cream-veined porcelain"
  },
  {
    "id": "wabi-sabi-02-v1",
    "styleId": "wabi-sabi",
    "name": "灰陶留白",
    "description": "灰陶、烟木与安静肌理",
    "palette": [
      "#B8B5AC",
      "#787C76",
      "#DAD5CA"
    ],
    "walls": "sealed gray-clay plaster",
    "floor": "smoked oak planks",
    "ceiling": "quiet pale-gray plaster ceiling",
    "furniture": "low gray linen upholstery and simple smoked-wood forms",
    "lighting": "off-white paper main fixture and gray ceramic lamps",
    "textiles": "gray flax and charcoal flatweave wool",
    "decor": "gray pottery and a sculptural stone",
    "wet": "soft-gray irregular white-veined porcelain"
  },
  {
    "id": "wabi-sabi-03-v1",
    "styleId": "wabi-sabi",
    "name": "土褐原木",
    "description": "土褐、原木与手作质感",
    "palette": [
      "#AF8F70",
      "#D4C1A2",
      "#E6D9C5"
    ],
    "walls": "finished warm-clay mineral plaster",
    "floor": "matte natural-oak planks",
    "ceiling": "warm-white plaster ceiling",
    "furniture": "solid natural timber with subtle irregular edges and beige linen",
    "lighting": "woven-fiber main shade and clay task lamps",
    "textiles": "unbleached flax and warm-brown wool",
    "decor": "dark earthenware and dried branches",
    "wet": "earth-brown subtle cream-veined porcelain"
  },
  {
    "id": "wabi-sabi-04-v1",
    "styleId": "wabi-sabi",
    "name": "炭木幽静",
    "description": "炭木、暖灰与低饱和层次",
    "palette": [
      "#555953",
      "#A59D8C",
      "#DCD4C4"
    ],
    "walls": "warm-gray sealed plaster with a limited charred-timber accent",
    "floor": "dark smoked-oak planks",
    "ceiling": "matte warm-gray ceiling",
    "furniture": "restrained dark-timber slabs and oatmeal linen upholstery",
    "lighting": "pale paper disk main light and dark stone task lamps",
    "textiles": "oatmeal flax and muted charcoal wool",
    "decor": "blackened ceramic bowl and spare branch arrangement",
    "wet": "charcoal-gray fine pale-veined porcelain"
  },
  {
    "id": "wabi-sabi-05-v1",
    "styleId": "wabi-sabi",
    "name": "米岩晨雾",
    "description": "米色石感、浅木与柔白织物",
    "palette": [
      "#E4D9C4",
      "#C6BAA4",
      "#F0EADF"
    ],
    "walls": "finished fine ivory mineral plaster",
    "floor": "light warm-stone-look porcelain",
    "ceiling": "continuous ivory plaster ceiling",
    "furniture": "pale solid-oak profiles and low off-white linen upholstery",
    "lighting": "irregular opal main fixture and light limestone task lamps",
    "textiles": "ivory linen and sand flatweave wool",
    "decor": "pale porous pottery and restrained line art",
    "wet": "ivory-beige sparse gray-veined porcelain"
  },
  {
    "id": "wabi-sabi-06-v1",
    "styleId": "wabi-sabi",
    "name": "赭陶暖境",
    "description": "赭色陶土、深木与自然褶皱",
    "palette": [
      "#B5815D",
      "#806751",
      "#DDCBB2"
    ],
    "walls": "muted ochre-clay plaster on a limited accent with warm beige elsewhere",
    "floor": "medium rustic-oak planks",
    "ceiling": "smooth warm-beige ceiling",
    "furniture": "low warm-wood forms and taupe linen upholstery",
    "lighting": "cream paper main shade and terracotta task lamps",
    "textiles": "crinkled natural linen and ochre woven accents",
    "decor": "terracotta vessels and dry botanical stems",
    "wet": "muted-ochre fine cream-veined porcelain"
  },
  {
    "id": "italian-minimalist-01-v1",
    "styleId": "italian-minimalist",
    "name": "洞石暖调",
    "description": "浅洞石、烟木与羊毛质感",
    "palette": [
      "#D8C8B0",
      "#6C5B4E",
      "#E8DFD1"
    ],
    "walls": "warm-white plaster with restrained honed travertine",
    "floor": "large matte travertine-look porcelain",
    "ceiling": "flat warm-white ceiling with fine shadow gaps",
    "furniture": "low taupe wool upholstery and smoked-oak monolithic forms",
    "lighting": "thin bronze sculptural main fixture and stone task lamps",
    "textiles": "fine taupe wool and sand linen",
    "decor": "honed stone bowl and bronze abstract object",
    "wet": "warm-travertine-tone linear-veined porcelain"
  },
  {
    "id": "italian-minimalist-02-v1",
    "styleId": "italian-minimalist",
    "name": "黑岩胡桃",
    "description": "深岩、胡桃木与皮革细节",
    "palette": [
      "#464944",
      "#72513C",
      "#D2C5B2"
    ],
    "walls": "walnut joinery with a restrained dark-stone accent",
    "floor": "matte dark-oak planks",
    "ceiling": "smooth warm-gray ceiling",
    "furniture": "precise walnut slabs and cognac leather upholstery",
    "lighting": "slim bronze linear main light and dark-metal task lamps",
    "textiles": "cognac leather and warm-gray wool",
    "decor": "dark stone vessel and restrained abstract art",
    "wet": "charcoal porcelain with fine ivory veins"
  },
  {
    "id": "italian-minimalist-03-v1",
    "styleId": "italian-minimalist",
    "name": "雾灰银影",
    "description": "雾灰石材、银色金属与利落比例",
    "palette": [
      "#C7CAC6",
      "#8F9798",
      "#E7E5DD"
    ],
    "walls": "fine cool-gray plaster with pale linear stone",
    "floor": "large matte gray limestone-look porcelain",
    "ceiling": "flat pale-gray ceiling",
    "furniture": "tailored gray upholstery with satin-steel and light-oak details",
    "lighting": "satin-nickel sculptural main fixture and opal task lamps",
    "textiles": "gray wool and ivory linen",
    "decor": "clear glass and pale stone sculpture",
    "wet": "silver-gray fine white-veined porcelain"
  },
  {
    "id": "italian-minimalist-04-v1",
    "styleId": "italian-minimalist",
    "name": "奶白皮革",
    "description": "奶白、浅驼皮革与柔和石感",
    "palette": [
      "#E6DCCC",
      "#BA9B7A",
      "#8C8173"
    ],
    "walls": "smooth ivory plaster",
    "floor": "honed pale limestone-look porcelain",
    "ceiling": "flat ivory ceiling",
    "furniture": "low cream upholstery with tan leather and pale-oak accents",
    "lighting": "shallow cream main fixture and brushed-bronze task lamps",
    "textiles": "fine ivory wool and smooth tan leather",
    "decor": "cream stone vessels and monochrome photography",
    "wet": "ivory delicate tan-veined porcelain"
  },
  {
    "id": "italian-minimalist-05-v1",
    "styleId": "italian-minimalist",
    "name": "摩卡雕塑",
    "description": "摩卡、暖石与克制雕塑曲线",
    "palette": [
      "#A48A76",
      "#D5C6B1",
      "#66584D"
    ],
    "walls": "matte mocha paint balanced with warm limestone panels",
    "floor": "medium smoked-oak planks",
    "ceiling": "smooth warm-beige ceiling",
    "furniture": "restrained curved mocha upholstery and rounded stone slabs",
    "lighting": "sculptural bronze main light and pleated neutral task lamps",
    "textiles": "mocha wool and pale linen",
    "decor": "carved stone object and low dark bowl",
    "wet": "taupe broad restrained ivory-veined porcelain"
  },
  {
    "id": "italian-minimalist-06-v1",
    "styleId": "italian-minimalist",
    "name": "橄榄岩语",
    "description": "橄榄灰、浅石与深木对比",
    "palette": [
      "#969780",
      "#D9D0BA",
      "#67584A"
    ],
    "walls": "muted olive-gray plaster with limited dark-oak panels",
    "floor": "matte pale-stone-look porcelain",
    "ceiling": "flat warm-white ceiling",
    "furniture": "low olive-gray upholstery and precise dark-wood joinery",
    "lighting": "blackened-bronze linear main fixture and ivory task shades",
    "textiles": "olive wool and oatmeal linen",
    "decor": "green-gray ceramic vessel and stone art object",
    "wet": "pale-olive-gray fine cream-veined porcelain"
  },
  {
    "id": "contemporary-luxury-01-v1",
    "styleId": "contemporary-luxury",
    "name": "香槟雅光",
    "description": "米白石材、香槟金属与细腻织物",
    "palette": [
      "#E8DECB",
      "#BDAD88",
      "#B4A89B"
    ],
    "walls": "warm-ivory finished panels with restrained pale-stone accents",
    "floor": "large matte cream marble-look porcelain",
    "ceiling": "smooth ivory ceiling with restrained cove detail",
    "furniture": "tailored cream upholstery and slim champagne-metal trims",
    "lighting": "refined champagne-metal main fixture with opal shades",
    "textiles": "ivory velvet and taupe fine wool",
    "decor": "white orchids and restrained pale-gold objects",
    "wet": "cream porcelain with fine champagne veins"
  },
  {
    "id": "contemporary-luxury-02-v1",
    "styleId": "contemporary-luxury",
    "name": "灰金凝光",
    "description": "暖灰、细金线与沉稳石纹",
    "palette": [
      "#B5B1A7",
      "#C3AE7E",
      "#E5E1D8"
    ],
    "walls": "warm-gray paint with narrow brass details",
    "floor": "matte warm-gray marble-look porcelain",
    "ceiling": "light-gray recessed ceiling",
    "furniture": "tailored gray upholstery and walnut pieces with fine brass edges",
    "lighting": "slender brass main chandelier and compact stone task lamps",
    "textiles": "gray velvet and ivory wool",
    "decor": "smoked glass and a small brass sculpture",
    "wet": "warm-gray sparse gold-veined porcelain"
  },
  {
    "id": "contemporary-luxury-03-v1",
    "styleId": "contemporary-luxury",
    "name": "翡翠映金",
    "description": "深绿、米白与克制黄铜",
    "palette": [
      "#42665A",
      "#E6DCC8",
      "#B29B65"
    ],
    "walls": "warm ivory panels with one muted deep-green accent",
    "floor": "matte ivory stone-look porcelain",
    "ceiling": "smooth warm-white ceiling",
    "furniture": "ivory tailored upholstery with emerald velvet accents and walnut",
    "lighting": "opal-and-brass main fixture and bronze task lamps",
    "textiles": "ivory linen and deep-green velvet",
    "decor": "green glass vessel and white floral stems",
    "wet": "ivory porcelain with restrained gray-green veins"
  },
  {
    "id": "contemporary-luxury-04-v1",
    "styleId": "contemporary-luxury",
    "name": "可可丝绒",
    "description": "可可、浅米与温润金属",
    "palette": [
      "#9B7E68",
      "#DCCDB9",
      "#BEA783"
    ],
    "walls": "warm-beige panels with dark walnut accents",
    "floor": "smoked-oak planks",
    "ceiling": "cream ceiling with a shallow perimeter recess",
    "furniture": "cocoa velvet upholstery and warm stone-topped walnut pieces",
    "lighting": "bronze sculptural main fixture with linen-shaded task lamps",
    "textiles": "cocoa velvet and ivory wool",
    "decor": "amber glass and warm abstract art",
    "wet": "beige porcelain with fine cocoa veins"
  },
  {
    "id": "contemporary-luxury-05-v1",
    "styleId": "contemporary-luxury",
    "name": "珍珠银灰",
    "description": "珍珠白、银灰与清透玻璃",
    "palette": [
      "#E8E7E1",
      "#AEB4B6",
      "#92918B"
    ],
    "walls": "pearl-gray finished panels with pale stone accents",
    "floor": "large matte pearl-white marble-look porcelain",
    "ceiling": "smooth white recessed ceiling",
    "furniture": "light-gray upholstery and satin-nickel detailed ash pieces",
    "lighting": "clear-and-opal glass main fixture with nickel fittings",
    "textiles": "pearl-gray velvet and silver-gray linen",
    "decor": "clear glass vases and white sculptural ceramics",
    "wet": "pearl-white porcelain with fine silver-gray veins"
  },
  {
    "id": "contemporary-luxury-06-v1",
    "styleId": "contemporary-luxury",
    "name": "琥珀暖境",
    "description": "琥珀、胡桃与浅色石材",
    "palette": [
      "#BB8959",
      "#765642",
      "#E3D5BC"
    ],
    "walls": "warm-white paint with restrained walnut panels",
    "floor": "matte pale-stone-look porcelain",
    "ceiling": "warm-ivory ceiling with subtle bronze trim",
    "furniture": "sand upholstery with amber leather accents and walnut storage",
    "lighting": "amber-glass main fixture with slim bronze stems",
    "textiles": "sand wool and caramel velvet accents",
    "decor": "amber glass vessel and dark ceramic bowl",
    "wet": "warm-ivory porcelain with fine amber veins"
  },
  {
    "id": "nordic-natural-01-v1",
    "styleId": "nordic-natural",
    "name": "白桦晨光",
    "description": "白桦、柔白与自然织纹",
    "palette": [
      "#EDEADF",
      "#D1BE97",
      "#A4AE95"
    ],
    "walls": "soft-white matte paint",
    "floor": "pale birch-toned oak planks",
    "ceiling": "matte white ceiling",
    "furniture": "airy birch frames and ivory cotton upholstery",
    "lighting": "simple white opal main fixture and pale-wood task lamps",
    "textiles": "natural cotton and light-gray knit wool",
    "decor": "small green plants and pale ceramics",
    "wet": "soft-white sparse beige-veined porcelain"
  },
  {
    "id": "nordic-natural-02-v1",
    "styleId": "nordic-natural",
    "name": "鼠尾草木",
    "description": "鼠尾草绿、浅橡木与松弛线条",
    "palette": [
      "#B1BCA5",
      "#D5C3A0",
      "#EBE6D9"
    ],
    "walls": "pale sage paint with warm-white balance",
    "floor": "natural pale-oak planks",
    "ceiling": "smooth warm-white ceiling",
    "furniture": "rounded oak frames and sage-gray linen upholstery",
    "lighting": "white paper main shade and muted-green metal task lamps",
    "textiles": "oatmeal linen and sage woven cushions",
    "decor": "green ceramic vessel and botanical prints",
    "wet": "pale-sage-gray fine white-veined porcelain"
  },
  {
    "id": "nordic-natural-03-v1",
    "styleId": "nordic-natural",
    "name": "海盐灰蓝",
    "description": "灰蓝、浅木与清爽棉麻",
    "palette": [
      "#A8BBC4",
      "#D1C1A4",
      "#EEECE4"
    ],
    "walls": "soft gray-blue paint balanced with white",
    "floor": "whitewashed-oak planks",
    "ceiling": "clean matte-white ceiling",
    "furniture": "pale timber frames and light-gray upholstery",
    "lighting": "opal globe main fixture and blue-gray task lamps",
    "textiles": "white linen and muted-blue cotton",
    "decor": "clear glass and simple blue ceramics",
    "wet": "pale-blue-gray delicate white-veined porcelain"
  },
  {
    "id": "nordic-natural-04-v1",
    "styleId": "nordic-natural",
    "name": "蜜木暖阳",
    "description": "蜜色木、米白与温暖羊毛",
    "palette": [
      "#C9A271",
      "#E6D8BE",
      "#B69169"
    ],
    "walls": "warm off-white matte paint",
    "floor": "honey-oak planks",
    "ceiling": "smooth cream ceiling",
    "furniture": "honey-oak tapered legs and oatmeal upholstery",
    "lighting": "warm-white drum main fixture and ceramic task lamps",
    "textiles": "cream knit wool and golden-beige linen",
    "decor": "honey-colored wooden bowl and small pottery",
    "wet": "warm-beige sparse amber-veined porcelain"
  },
  {
    "id": "nordic-natural-05-v1",
    "styleId": "nordic-natural",
    "name": "桦木莓灰",
    "description": "浅木、莓灰与柔和几何",
    "palette": [
      "#C8ADA9",
      "#DACAAE",
      "#E9E4DD"
    ],
    "walls": "very pale dusty-rose gray paint with off-white areas",
    "floor": "light birch-toned oak planks",
    "ceiling": "flat warm-white ceiling",
    "furniture": "simple birch forms and warm-gray upholstery with berry-gray accents",
    "lighting": "white disk main light and pale-rose metal task lamps",
    "textiles": "ivory wool and muted berry linen",
    "decor": "blush-gray ceramics and restrained geometric prints",
    "wet": "warm-ivory fine dusty-rose-veined porcelain"
  },
  {
    "id": "nordic-natural-06-v1",
    "styleId": "nordic-natural",
    "name": "松影浅灰",
    "description": "松绿、浅灰与实用木作",
    "palette": [
      "#8E9B87",
      "#CFCFC4",
      "#C1A77F"
    ],
    "walls": "light-gray matte paint with restrained pine-green accent",
    "floor": "natural light-oak planks",
    "ceiling": "matte white ceiling",
    "furniture": "oak utility joinery and light-gray fabric upholstery",
    "lighting": "simple green-gray main pendant and black task lamps",
    "textiles": "gray wool and natural cotton",
    "decor": "woven storage baskets and leafy plants",
    "wet": "light-gray restrained green-gray-veined porcelain"
  },
  {
    "id": "new-chinese-01-v1",
    "styleId": "new-chinese",
    "name": "墨韵雅居",
    "description": "米白、墨灰与清雅胡桃木",
    "palette": [
      "#E8DFCC",
      "#545951",
      "#806147"
    ],
    "walls": "warm rice-white plaster with restrained walnut panels",
    "floor": "medium walnut planks",
    "ceiling": "flat ivory ceiling with thin walnut trim",
    "furniture": "slim contemporary walnut frames and oatmeal linen upholstery",
    "lighting": "low-profile bronze linear main fixture and modern ivory task shades",
    "textiles": "ivory linen with small ink-gray woven accents",
    "decor": "contemporary ink-inspired art and dark ceramic branch vase",
    "wet": "warm-ivory restrained ink-gray-veined porcelain"
  },
  {
    "id": "new-chinese-02-v1",
    "styleId": "new-chinese",
    "name": "宋韵浅木",
    "description": "浅木、米白与温润茶色",
    "palette": [
      "#D7C29C",
      "#EEE6D3",
      "#A69973"
    ],
    "walls": "smooth warm-ivory plaster",
    "floor": "pale natural-oak planks",
    "ceiling": "quiet ivory ceiling",
    "furniture": "refined pale-oak joinery and cream linen upholstery",
    "lighting": "flattened opal main fixture and pale-wood task lamps",
    "textiles": "unbleached linen and tea-colored woven cotton",
    "decor": "ivory ceramics and a single fresh branch",
    "wet": "pale-beige sparse gray-veined porcelain"
  },
  {
    "id": "new-chinese-03-v1",
    "styleId": "new-chinese",
    "name": "青瓷映月",
    "description": "青瓷绿、月白与深木细节",
    "palette": [
      "#A7BDB1",
      "#E9E7D9",
      "#71614E"
    ],
    "walls": "warm-white plaster with a limited celadon accent",
    "floor": "natural medium-oak planks",
    "ceiling": "smooth moon-white ceiling",
    "furniture": "slim dark-oak frames and pale-gray upholstery",
    "lighting": "contemporary opal main fixture with bronze fittings",
    "textiles": "moon-white linen and celadon silk-blend accents",
    "decor": "celadon vessel and restrained botanical ink artwork",
    "wet": "pale-celadon-gray fine white-veined porcelain"
  },
  {
    "id": "new-chinese-04-v1",
    "styleId": "new-chinese",
    "name": "胡桃暖境",
    "description": "胡桃、茶褐与柔暖米色",
    "palette": [
      "#79593F",
      "#D9C6AA",
      "#AD906E"
    ],
    "walls": "warm-beige finished plaster with flat walnut joinery",
    "floor": "natural walnut planks",
    "ceiling": "flat cream ceiling with fine dark trim",
    "furniture": "clean walnut profiles and sand upholstery with tobacco leather accents",
    "lighting": "low-profile bronze main light and linen-shaded modern task lamps",
    "textiles": "sand linen and tea-brown woven cotton",
    "decor": "brown glazed pottery and warm abstract ink art",
    "wet": "beige flowing brown-gray-veined porcelain"
  },
  {
    "id": "new-chinese-05-v1",
    "styleId": "new-chinese",
    "name": "朱砂留白",
    "description": "大面积米白与少量朱砂点色",
    "palette": [
      "#EEE4D1",
      "#A95443",
      "#8A7256"
    ],
    "walls": "rice-white matte plaster with restrained pale-oak joinery",
    "floor": "pale warm-oak planks",
    "ceiling": "plain ivory ceiling",
    "furniture": "contemporary pale-oak frames and ivory upholstery",
    "lighting": "refined white linear main fixture with bronze details",
    "textiles": "ivory linen with small muted-cinnabar accents",
    "decor": "one red-brown ceramic object and restrained monochrome ink art",
    "wet": "warm-white fine beige-veined porcelain"
  },
  {
    "id": "new-chinese-06-v1",
    "styleId": "new-chinese",
    "name": "水墨石庭",
    "description": "灰石、墨木与清淡织物",
    "palette": [
      "#B9B9AD",
      "#505A53",
      "#DFD8C4"
    ],
    "walls": "fine warm-gray plaster with a limited matte-stone accent",
    "floor": "matte gray stone-look porcelain",
    "ceiling": "quiet off-white ceiling",
    "furniture": "low dark-timber and stone forms with pale linen upholstery",
    "lighting": "shallow opal main fixture and dark-bronze task lamps",
    "textiles": "flax linen and pale-gray woven cotton",
    "decor": "gray stone vessel and a single sculptural branch",
    "wet": "ink-gray subtle white-veined porcelain"
  },
  {
    "id": "mid-century-modern-01-v1",
    "styleId": "mid-century-modern",
    "name": "胡桃焦糖",
    "description": "胡桃、焦糖皮革与经典曲线",
    "palette": [
      "#825A3D",
      "#BB8756",
      "#DFCAA4"
    ],
    "walls": "warm-cream paint with restrained walnut panels",
    "floor": "warm walnut planks",
    "ceiling": "matte cream ceiling",
    "furniture": "tapered walnut legs and caramel leather upholstery",
    "lighting": "brass-and-opal main fixture and ceramic task lamps",
    "textiles": "warm linen and muted geometric wool",
    "decor": "amber glass and vintage-inspired abstract prints",
    "wet": "cream porcelain with fine amber veins"
  },
  {
    "id": "mid-century-modern-02-v1",
    "styleId": "mid-century-modern",
    "name": "橄榄复调",
    "description": "橄榄绿、柚木与柔暖米色",
    "palette": [
      "#929873",
      "#B58E5B",
      "#E5D7BC"
    ],
    "walls": "muted olive paint balanced with cream",
    "floor": "honey-oak planks",
    "ceiling": "flat warm-white ceiling",
    "furniture": "clean teak profiles and olive fabric upholstery",
    "lighting": "cream globe cluster main fixture and olive metal task lamps",
    "textiles": "beige wool and olive woven cotton",
    "decor": "glazed green pottery and geometric artwork",
    "wet": "muted-ivory fine olive-brown-veined porcelain"
  },
  {
    "id": "mid-century-modern-03-v1",
    "styleId": "mid-century-modern",
    "name": "奶油樱桃",
    "description": "奶油白、樱桃木与温暖红褐",
    "palette": [
      "#E6D7BD",
      "#9D5E46",
      "#C19B75"
    ],
    "walls": "warm-cream matte paint",
    "floor": "medium cherry-toned timber planks",
    "ceiling": "smooth ivory ceiling",
    "furniture": "slender cherry-wood frames and ivory upholstery",
    "lighting": "white mushroom-shaped main fixture and warm ceramic task lamps",
    "textiles": "cream linen and small rust-colored woven accents",
    "decor": "red-brown pottery and graphic vintage art",
    "wet": "warm-ivory fine reddish-brown-veined porcelain"
  },
  {
    "id": "mid-century-modern-04-v1",
    "styleId": "mid-century-modern",
    "name": "芥末暖棕",
    "description": "芥末黄、暖棕与细木脚",
    "palette": [
      "#B5A04D",
      "#805F45",
      "#DDD0B2"
    ],
    "walls": "pale warm-beige paint",
    "floor": "medium walnut planks",
    "ceiling": "matte cream ceiling",
    "furniture": "walnut tapered-leg forms with mustard upholstery accents",
    "lighting": "restrained brass starburst main fixture and dark ceramic lamps",
    "textiles": "oatmeal wool and mustard cotton",
    "decor": "ochre ceramics and simple geometric prints",
    "wet": "warm-beige sparse ochre-veined porcelain"
  },
  {
    "id": "mid-century-modern-05-v1",
    "styleId": "mid-century-modern",
    "name": "海军蓝木",
    "description": "深蓝、胡桃与温润黄铜",
    "palette": [
      "#3F586B",
      "#906D4A",
      "#E2D5BA"
    ],
    "walls": "warm-white paint with a restrained navy accent",
    "floor": "honey-walnut planks",
    "ceiling": "smooth warm-white ceiling",
    "furniture": "walnut slab forms and navy upholstery with tan leather details",
    "lighting": "opal main fixture with brass stems and navy task lamps",
    "textiles": "navy wool and ivory linen",
    "decor": "dark-blue pottery and warm geometric art",
    "wet": "ivory fine blue-gray-veined porcelain"
  },
  {
    "id": "mid-century-modern-06-v1",
    "styleId": "mid-century-modern",
    "name": "砖红柚木",
    "description": "砖红、柚木与奶白平衡",
    "palette": [
      "#AE7053",
      "#BD9965",
      "#E7DCC6"
    ],
    "walls": "soft cream paint with a muted brick-red accent",
    "floor": "warm teak-toned timber planks",
    "ceiling": "matte cream ceiling",
    "furniture": "low teak forms and sand upholstery with brick-red accents",
    "lighting": "cream opal main fixture and rust ceramic task lamps",
    "textiles": "cream cotton and terracotta flatweave wool",
    "decor": "handmade red-brown vessels and abstract color-block art",
    "wet": "warm-cream fine terracotta-veined porcelain"
  },
  {
    "id": "japandi-01-v1",
    "styleId": "japandi",
    "name": "浅木和光",
    "description": "浅橡木、暖白与低矮线条",
    "palette": [
      "#D6C5A4",
      "#EDE6D8",
      "#ABA48E"
    ],
    "walls": "warm-white matte plaster",
    "floor": "pale-oak planks",
    "ceiling": "smooth off-white ceiling",
    "furniture": "low pale-oak frames and natural linen upholstery",
    "lighting": "flattened paper main fixture and slim wood task lamps",
    "textiles": "unbleached linen and ivory wool",
    "decor": "pale handmade pottery and a fresh branch",
    "wet": "warm-limestone-tone fine ivory-veined porcelain"
  },
  {
    "id": "japandi-02-v1",
    "styleId": "japandi",
    "name": "米灰竹影",
    "description": "米灰、竹色与轻巧编织",
    "palette": [
      "#C9C4B5",
      "#B8A17A",
      "#E7E1D3"
    ],
    "walls": "pale greige mineral plaster",
    "floor": "light bamboo-toned timber planks",
    "ceiling": "warm-white ceiling with restrained pale-timber detail",
    "furniture": "slim light-timber frames and woven-seat accents",
    "lighting": "soft woven-paper main shade and gray ceramic task lamps",
    "textiles": "beige cotton canvas and natural flax",
    "decor": "small fern and sand ceramics",
    "wet": "quiet-greige sparse gray-veined porcelain"
  },
  {
    "id": "japandi-03-v1",
    "styleId": "japandi",
    "name": "炭木素白",
    "description": "炭木、素白与克制对比",
    "palette": [
      "#515A50",
      "#E5E0D2",
      "#B4A98E"
    ],
    "walls": "warm-white plaster with limited dark-oak joinery",
    "floor": "natural medium-oak planks",
    "ceiling": "flat ivory ceiling",
    "furniture": "low dark-timber profiles and ivory linen upholstery",
    "lighting": "broad white paper main shade and dark metal task lamps",
    "textiles": "ivory linen and charcoal flatweave wool",
    "decor": "dark ceramic vessel and spare branch",
    "wet": "ivory fine charcoal-veined porcelain"
  },
  {
    "id": "japandi-04-v1",
    "styleId": "japandi",
    "name": "茶褐暖棉",
    "description": "茶褐、暖木与柔软棉麻",
    "palette": [
      "#AA9374",
      "#D9C8AA",
      "#ECE1CF"
    ],
    "walls": "soft tea-beige plaster",
    "floor": "warm natural-oak planks",
    "ceiling": "matte cream ceiling",
    "furniture": "rounded oak profiles and oatmeal cotton upholstery",
    "lighting": "warm-white opal main light and pale-clay task lamps",
    "textiles": "natural cotton and tea-colored wool",
    "decor": "tea-brown pottery and warm woven baskets",
    "wet": "pale-beige fine tea-brown-veined porcelain"
  },
  {
    "id": "japandi-05-v1",
    "styleId": "japandi",
    "name": "苔绿静木",
    "description": "苔绿、浅木与安静留白",
    "palette": [
      "#A2AE92",
      "#D4C6A7",
      "#E8E4D6"
    ],
    "walls": "warm-white paint with restrained pale moss-green areas",
    "floor": "pale ash-toned oak planks",
    "ceiling": "plain warm-white ceiling",
    "furniture": "low ash frames and ivory linen upholstery",
    "lighting": "ivory paper main fixture and muted-green task lamps",
    "textiles": "ivory cotton and soft moss linen",
    "decor": "green-gray pottery and a slender leafy branch",
    "wet": "pale-moss-gray delicate cream-veined porcelain"
  },
  {
    "id": "japandi-06-v1",
    "styleId": "japandi",
    "name": "素石亚麻",
    "description": "浅石、亚麻与温润木块",
    "palette": [
      "#D5CEBF",
      "#C1AE8D",
      "#EEE8DC"
    ],
    "walls": "smooth pale-stone mineral plaster",
    "floor": "matte light limestone-look porcelain",
    "ceiling": "seamless off-white ceiling",
    "furniture": "low solid-oak slabs and flax linen upholstery",
    "lighting": "simple opal disk main fixture and limestone task lamps",
    "textiles": "flax linen and sand wool",
    "decor": "light stone bowl and unglazed ceramics",
    "wet": "pale-limestone-tone sparse gray-veined porcelain"
  },
  {
    "id": "french-modern-01-v1",
    "styleId": "french-modern",
    "name": "奶白金线",
    "description": "奶白墙线、浅橡木与细黄铜",
    "palette": [
      "#EEE3CF",
      "#C5AC7E",
      "#D4BD98"
    ],
    "walls": "warm-ivory finished panels with thin restrained mouldings",
    "floor": "pale-oak chevron planks",
    "ceiling": "smooth ivory ceiling with a thin cornice",
    "furniture": "graceful pale-oak forms and ivory linen upholstery",
    "lighting": "restrained brass-and-opal main fixture and pleated cream task lamps",
    "textiles": "ivory linen and soft cream wool",
    "decor": "fresh white flowers and pale ceramics",
    "wet": "warm-ivory fine gold-veined porcelain"
  },
  {
    "id": "french-modern-02-v1",
    "styleId": "french-modern",
    "name": "雾蓝雅序",
    "description": "雾蓝、柔白与浅色石感",
    "palette": [
      "#B8C9CC",
      "#E8E4D8",
      "#BAAA8E"
    ],
    "walls": "pale mist-blue finished panels with simple narrow mouldings",
    "floor": "pale natural-oak planks",
    "ceiling": "smooth white ceiling with slim cornice",
    "furniture": "restrained curved light-gray upholstery and pale-wood joinery",
    "lighting": "opal-glass main fixture with satin-nickel fittings",
    "textiles": "soft-white linen and muted-blue woven accents",
    "decor": "blue-gray pottery and delicate floral stems",
    "wet": "soft-gray delicate blue-veined porcelain"
  },
  {
    "id": "french-modern-03-v1",
    "styleId": "french-modern",
    "name": "杏桃柔曲",
    "description": "杏桃、奶白与柔和曲面",
    "palette": [
      "#E4C5B3",
      "#EFE5D6",
      "#BEA785"
    ],
    "walls": "very pale apricot finished panels with restrained moulding",
    "floor": "warm pale-oak chevron planks",
    "ceiling": "cream ceiling with a simple shallow cornice",
    "furniture": "curved ivory upholstery and pale-oak fluted details",
    "lighting": "frosted-glass main fixture and cream pleated task lamps",
    "textiles": "ivory linen and dusty-peach wool accents",
    "decor": "blush ceramics and loose garden flowers",
    "wet": "pale-apricot fine cream-veined porcelain"
  },
  {
    "id": "french-modern-04-v1",
    "styleId": "french-modern",
    "name": "黑白雅线",
    "description": "柔白、少量黑线与经典浅木",
    "palette": [
      "#EEE8DD",
      "#424846",
      "#C7B497"
    ],
    "walls": "soft-white panels with fine simple mouldings",
    "floor": "pale-oak chevron planks",
    "ceiling": "flat white ceiling with thin cornice",
    "furniture": "ivory curved upholstery with slim black accents and pale oak",
    "lighting": "black-and-opal main fixture and ivory fabric task lamps",
    "textiles": "white linen and restrained black piping",
    "decor": "white ceramic vase and black-framed abstract art",
    "wet": "white porcelain with restrained charcoal veins"
  },
  {
    "id": "french-modern-05-v1",
    "styleId": "french-modern",
    "name": "鼠尾草花影",
    "description": "灰绿、奶白与自然花艺",
    "palette": [
      "#B1BBA7",
      "#E9DFCD",
      "#C2AB85"
    ],
    "walls": "pale sage panels with light restrained mouldings",
    "floor": "natural light-oak planks",
    "ceiling": "smooth warm-white ceiling",
    "furniture": "pale-oak frames and cream linen upholstery",
    "lighting": "aged-brass main fixture with small opal shades",
    "textiles": "ivory linen and pale-sage wool",
    "decor": "fresh garden flowers and sage ceramic vase",
    "wet": "ivory fine green-gray-veined porcelain"
  },
  {
    "id": "french-modern-06-v1",
    "styleId": "french-modern",
    "name": "胡桃香槟",
    "description": "胡桃、香槟米与精简法式线条",
    "palette": [
      "#8B6C50",
      "#DFCFB0",
      "#B8A47D"
    ],
    "walls": "champagne-beige finished panels with thin mouldings",
    "floor": "warm walnut planks",
    "ceiling": "ivory ceiling with a slim simple cornice",
    "furniture": "tailored cream upholstery and walnut fluted storage",
    "lighting": "refined bronze-and-glass main fixture and pleated ivory lamps",
    "textiles": "cream wool and warm taupe linen",
    "decor": "amber glass vase and restrained floral artwork",
    "wet": "champagne-beige fine brown-veined porcelain"
  },
  {
    "id": "industrial-loft-01-v1",
    "styleId": "industrial-loft",
    "name": "水泥烟木",
    "description": "完成面水泥、烟木与暖灰",
    "palette": [
      "#A1A29B",
      "#78624E",
      "#D4C9B6"
    ],
    "walls": "deliberately finished sealed warm-gray concrete",
    "floor": "smoked-oak planks",
    "ceiling": "smooth sealed gray ceiling",
    "furniture": "rivet-free black-steel frames and gray canvas upholstery",
    "lighting": "black metal main fixture plus restrained track accents",
    "textiles": "gray canvas and coarse oatmeal wool",
    "decor": "large simple ceramic vessel and a green plant",
    "wet": "concrete-gray fine white-veined porcelain"
  },
  {
    "id": "industrial-loft-02-v1",
    "styleId": "industrial-loft",
    "name": "黑钢焦糖",
    "description": "黑钢、焦糖皮革与温暖木面",
    "palette": [
      "#424846",
      "#AE7B50",
      "#B8A68C"
    ],
    "walls": "warm mineral-gray plaster with restrained dark steel details",
    "floor": "medium warm-oak planks",
    "ceiling": "matte charcoal ceiling where appropriate to existing room height",
    "furniture": "slim black-steel profiles and caramel leather upholstery",
    "lighting": "broad black metal main shade and steel task lamps",
    "textiles": "cognac leather and sand flatweave wool",
    "decor": "dark pottery and monochrome industrial photography",
    "wet": "warm-gray restrained tan-veined porcelain"
  },
  {
    "id": "industrial-loft-03-v1",
    "styleId": "industrial-loft",
    "name": "暖砖工坊",
    "description": "暖砖、浅灰与朴素木作",
    "palette": [
      "#A8775C",
      "#CBC5B6",
      "#7A6852"
    ],
    "walls": "one sealed muted brick accent with completed warm-gray plaster",
    "floor": "natural medium-oak planks",
    "ceiling": "finished warm-white ceiling",
    "furniture": "clean reclaimed-oak forms and sand canvas upholstery",
    "lighting": "enamel main fixture and dark metal task lamps",
    "textiles": "natural canvas and rust wool accents",
    "decor": "terracotta vessels and restrained graphic art",
    "wet": "warm-beige fine rust-gray-veined porcelain"
  },
  {
    "id": "industrial-loft-04-v1",
    "styleId": "industrial-loft",
    "name": "浅灰金属",
    "description": "浅灰矿物、拉丝钢与柔白",
    "palette": [
      "#CBCFC9",
      "#929D9C",
      "#E3DFD2"
    ],
    "walls": "sealed pale-gray mineral plaster",
    "floor": "large matte pale-gray concrete-look porcelain",
    "ceiling": "smooth light-gray ceiling",
    "furniture": "brushed-steel frames and light-gray fabric upholstery",
    "lighting": "satin-steel main fixture with opal diffuser",
    "textiles": "gray linen and ivory flatweave cotton",
    "decor": "clear glass and simple pale ceramics",
    "wet": "pale-gray sparse white-veined porcelain"
  },
  {
    "id": "industrial-loft-05-v1",
    "styleId": "industrial-loft",
    "name": "煤灰胡桃",
    "description": "煤灰、胡桃与皮革暖点",
    "palette": [
      "#626862",
      "#89694C",
      "#C6B398"
    ],
    "walls": "finished charcoal mineral paint with limited walnut panels",
    "floor": "warm walnut planks",
    "ceiling": "smooth warm-gray ceiling",
    "furniture": "walnut slabs with blackened-steel edges and tan leather",
    "lighting": "graphite linear main fixture and bronze task lamps",
    "textiles": "tan leather and muted charcoal wool",
    "decor": "black ceramic bowl and warm abstract art",
    "wet": "charcoal-gray restrained cream-veined porcelain"
  },
  {
    "id": "industrial-loft-06-v1",
    "styleId": "industrial-loft",
    "name": "橄榄机能",
    "description": "橄榄灰、黑钢与耐看织物",
    "palette": [
      "#8D9780",
      "#434B43",
      "#C6B99E"
    ],
    "walls": "muted olive-gray paint with finished light-concrete areas",
    "floor": "smoked-oak planks",
    "ceiling": "completed light-gray ceiling",
    "furniture": "simple black-steel utility frames and olive canvas upholstery",
    "lighting": "black metal main light with ivory diffusers",
    "textiles": "olive canvas and sand flatweave wool",
    "decor": "dark-green pottery and functional woven storage",
    "wet": "olive-gray fine pale-veined porcelain"
  },
  {
    "id": "coastal-relaxed-01-v1",
    "styleId": "coastal-relaxed",
    "name": "沙白亚麻",
    "description": "沙白、浅木与清爽亚麻",
    "palette": [
      "#EBE3D1",
      "#CBB997",
      "#D9D9CC"
    ],
    "walls": "airy warm-white plaster",
    "floor": "pale washed-oak planks",
    "ceiling": "smooth white ceiling",
    "furniture": "relaxed pale-oak frames and ivory linen upholstery",
    "lighting": "light woven main shade and white ceramic task lamps",
    "textiles": "ivory linen and sand cotton",
    "decor": "simple white pottery and restrained greenery",
    "wet": "sand-tone sparse pale-veined porcelain"
  },
  {
    "id": "coastal-relaxed-02-v1",
    "styleId": "coastal-relaxed",
    "name": "海盐蓝调",
    "description": "海盐蓝、柔白与漂洗木色",
    "palette": [
      "#B7CED2",
      "#F0ECE0",
      "#C9BA9B"
    ],
    "walls": "pale sea-salt-blue paint balanced with white",
    "floor": "whitewashed-oak planks",
    "ceiling": "plain white ceiling",
    "furniture": "washed-timber frames and white cotton upholstery",
    "lighting": "white opal main fixture and pale-blue ceramic lamps",
    "textiles": "white linen and soft blue cotton",
    "decor": "pale-blue glass and simple greenery",
    "wet": "soft-blue-gray fine white-veined porcelain"
  },
  {
    "id": "coastal-relaxed-03-v1",
    "styleId": "coastal-relaxed",
    "name": "鼠尾草海风",
    "description": "灰绿、沙色与自然编织",
    "palette": [
      "#B6C1A7",
      "#DED1B7",
      "#ECE7DA"
    ],
    "walls": "pale sage-gray paint with warm-white areas",
    "floor": "natural pale-oak planks",
    "ceiling": "smooth warm-white ceiling",
    "furniture": "light-oak frames and restrained woven-rattan accents",
    "lighting": "pale woven main fixture and sage ceramic task lamps",
    "textiles": "sand linen and light-green cotton",
    "decor": "green-gray pottery and airy leafy stems",
    "wet": "pale-sage-gray delicate cream-veined porcelain"
  },
  {
    "id": "coastal-relaxed-04-v1",
    "styleId": "coastal-relaxed",
    "name": "贝白藤影",
    "description": "贝白、浅藤与温柔棉织",
    "palette": [
      "#EEE7D8",
      "#CAB185",
      "#D5C8AF"
    ],
    "walls": "soft shell-white finished plaster",
    "floor": "matte pale-limestone-look porcelain",
    "ceiling": "white ceiling with restrained shallow timber detail",
    "furniture": "pale rattan curves and cream cotton upholstery",
    "lighting": "white woven main shade and round ivory ceramic lamps",
    "textiles": "white cotton and natural flax",
    "decor": "shell-white ceramics without nautical motifs",
    "wet": "shell-white delicate gray-veined porcelain"
  },
  {
    "id": "coastal-relaxed-05-v1",
    "styleId": "coastal-relaxed",
    "name": "深蓝浅沙",
    "description": "少量深蓝、浅沙与白色木作",
    "palette": [
      "#4D6B7D",
      "#DED0B1",
      "#EEEBDF"
    ],
    "walls": "warm-white paint with a limited muted-navy accent",
    "floor": "pale-oak planks",
    "ceiling": "smooth white ceiling",
    "furniture": "whitewashed-wood frames and sand upholstery with navy accents",
    "lighting": "white-and-navy main fixture and cream task lamps",
    "textiles": "white linen and restrained navy striped cotton",
    "decor": "blue ceramic vessel and coastal botanical artwork",
    "wet": "ivory fine muted-blue-veined porcelain"
  },
  {
    "id": "coastal-relaxed-06-v1",
    "styleId": "coastal-relaxed",
    "name": "暖砂落日",
    "description": "暖砂、浅陶土与自然木色",
    "palette": [
      "#D5BB95",
      "#C99574",
      "#EDE1CB"
    ],
    "walls": "warm-sand plaster with a pale terracotta accent",
    "floor": "natural light-oak planks",
    "ceiling": "smooth warm-ivory ceiling",
    "furniture": "relaxed light-timber forms and cream linen upholstery",
    "lighting": "pale woven main fixture and sand ceramic lamps",
    "textiles": "ivory linen and faded terracotta cotton",
    "decor": "sand pottery and warm botanical stems",
    "wet": "warm-sand fine amber-veined porcelain"
  }
] as DesignScheme[];
const V2_SCHEMES: readonly DesignScheme[] = V2_RECIPES.map((recipe) => {
  const previous = SCHEMES.find((scheme) => scheme.id === recipe.id.replace(/-v2$/u, "-v1"));
  if (!previous) throw new Error(`Missing v1 scheme metadata for ${recipe.id}`);
  return { ...previous, ...recipe };
});
const V3_SCHEMES: readonly DesignScheme[] = V2_SCHEMES.map((scheme) => scheme.id === "cream-cozy-02-v2" ? { ...scheme, id: "cream-cozy-02-v3" } : scheme.id === "industrial-loft-02-v2" ? { ...scheme, id: "industrial-loft-02-v3" } : scheme);
const V4_SCHEMES: readonly DesignScheme[] = V3_SCHEMES.map((scheme) => scheme.id === "industrial-loft-02-v3" ? { ...scheme, id: "industrial-loft-02-v4" } : scheme);
const V5_SCHEMES: readonly DesignScheme[] = V4_SCHEMES.map((scheme) => scheme.id === "industrial-loft-02-v4" ? { ...scheme, id: "industrial-loft-02-v5", description: "黑钢、暖木与焦糖棕，按空间搭配" } : scheme);
const V6_SCHEMES: readonly DesignScheme[] = V5_SCHEMES.map((scheme) => scheme.id === "industrial-loft-02-v5" ? { ...scheme, id: "industrial-loft-02-v6" } : scheme);
const V7_SCHEMES: readonly DesignScheme[] = V6_SCHEMES.map((scheme) => scheme.id === "cream-cozy-02-v3" ? { ...scheme, id: "cream-cozy-02-v4" } : scheme.id === "modern-minimalist-04-v2" ? { ...scheme, id: "modern-minimalist-04-v3" } : scheme.id === "french-modern-05-v2" ? { ...scheme, id: "french-modern-05-v3" } : scheme.id === "industrial-loft-02-v6" ? { ...scheme, id: "industrial-loft-02-v7" } : scheme);
const stem = (id: string) => id.replace(/-v\d+$/u, "");
const V8_SCHEMES: readonly DesignScheme[] = V8_RECIPES.map((recipe) => {
  const previous = V7_SCHEMES.find((scheme) => stem(scheme.id) === stem(recipe.id));
  if (!previous) throw new Error(`Missing previous scheme metadata for ${recipe.id}`);
  return { ...previous, ...recipe };
});
const V9_SCHEMES: readonly DesignScheme[] = V9_CEILINGS.map(({ id, ceiling }) => {
  const previous = V8_SCHEMES.find((scheme) => stem(scheme.id) === stem(id));
  if (!previous) throw new Error(`Missing v8 scheme metadata for ${id}`);
  return { ...previous, id, ceiling };
});
const CURRENT_SCHEMES: readonly DesignScheme[] = [...V9_SCHEMES.map((scheme) => ({ ...scheme, id: scheme.id.replace(/-v9$/u, "-v10") })), ...NEW_SCHEME_DATA];
const HISTORY = [V9_SCHEMES, V8_SCHEMES, V7_SCHEMES, V6_SCHEMES, V5_SCHEMES, V4_SCHEMES, V3_SCHEMES, V2_SCHEMES, SCHEMES];
export function getDesignScheme(id: string): DesignScheme | undefined { return CURRENT_SCHEMES.find((scheme) => scheme.id === id) ?? HISTORY.flatMap((schemes) => schemes).find((scheme) => scheme.id === id); }
export function firstDesignScheme(styleId: string): DesignScheme | undefined { return CURRENT_SCHEMES.find((scheme) => scheme.styleId === styleId); }
export function firstV2DesignScheme(styleId: string): DesignScheme | undefined { return V2_SCHEMES.find((scheme) => scheme.styleId === styleId); }
export function firstLegacyDesignScheme(styleId: string): DesignScheme | undefined { return SCHEMES.find((scheme) => scheme.styleId === styleId); }
export function listPublicDesignSchemes(styleId: string) { return CURRENT_SCHEMES.filter((scheme) => scheme.styleId === styleId).map(({ id, name, description, palette }) => {
  const historicalIds = [...new Set(HISTORY.map((schemes) => schemes.find((scheme) => stem(scheme.id) === stem(id))?.id).filter((value): value is string => Boolean(value)))];
  return { id, ...(historicalIds[0] ? { previousVersionId: historicalIds[0] } : {}), legacyVersionIds: historicalIds.slice(1), name, description, palette };
}); }
export function allDesignSchemes(): readonly DesignScheme[] { return CURRENT_SCHEMES; }
export function allLegacyDesignSchemes(): readonly DesignScheme[] { return SCHEMES; }
