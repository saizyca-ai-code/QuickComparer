/**
 * Compositor 的 GLSL。
 *
 * 兩個關鍵設計：
 *
 * 1. 所有混合一律在「線性光」下進行，中間結果寫進 half-float FBO。
 *    在 8-bit sRGB 空間直接混合是錯的 —— 邊界會出現假的暗帶，而做細節比對時
 *    這種假象會被誤讀成畫質差異。這是 D001 把 half-float 列為必要條件的原因。
 *
 * 2. 輸出轉換是獨立的一個 pass（COMPOSITE → OUTPUT），不是黏在合成末端。
 *    ACES ODT 之後要接進來時，換的是這個 pass，合成核心完全不動。
 */

/** 全螢幕三角形。比 quad 少一次頂點插值接縫，也不需要 index buffer。 */
export const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

/**
 * 合成用的公用函式：轉換函數與取樣。
 *
 * #version 必須是整個 shader 的第一行，所以它放在這裡而不是各 shader 自己加 ——
 * 少了它會被當成 GLSL ES 1.00 編譯，texture() 與 out 變數全部失效。
 */
const COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;

// 轉換函數代碼，與 TS 端的 TransferFunction 對應。
const int TF_SRGB   = 0;  // IEC 61966-2-1
const int TF_BT709  = 1;  // ITU-R BT.709 / BT.1886 相機端
const int TF_LINEAR = 2;  // 已是線性（EXR 之後會走這條）

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

// BT.709 的相機端 OETF。注意它和 sRGB 不同 —— 兩者混用會造成約 1-2% 的亮度偏移，
// 在做 A/B 細節比對時這個量級剛好會被誤判成「其中一邊比較亮/比較銳利」。
vec3 bt709ToLinear(vec3 c) {
  vec3 lo = c / 4.5;
  vec3 hi = pow((c + 0.099) / 1.099, vec3(1.0 / 0.45));
  return mix(lo, hi, step(vec3(0.081), c));
}

vec3 linearToBt709(vec3 c) {
  vec3 lo = c * 4.5;
  vec3 hi = 1.099 * pow(c, vec3(0.45)) - 0.099;
  return mix(lo, hi, step(vec3(0.018), c));
}

vec3 toLinear(vec3 c, int tf) {
  if (tf == TF_SRGB)  return srgbToLinear(c);
  if (tf == TF_BT709) return bt709ToLinear(c);
  return c;
}

vec3 fromLinear(vec3 c, int tf) {
  if (tf == TF_SRGB)  return linearToSrgb(c);
  if (tf == TF_BT709) return linearToBt709(c);
  return c;
}

// Catmull-Rom bicubic。用在放大較小的素材時的可選插值。
// 預設不是這個 —— 比對 upscaler 時，用高品質插值放大原圖等於偷偷幫原圖加分。
vec4 sampleBicubic(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 coord = uv * texSize - 0.5;
  vec2 f = fract(coord);
  vec2 base = floor(coord);

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 s0 = w0 + w1;
  vec2 s1 = w2 + w3;
  vec2 o0 = (w1 / s0 - 0.5 + base) / texSize;
  vec2 o1 = (w3 / s1 + 1.5 + base) / texSize;

  vec4 a = texture(tex, vec2(o0.x, o0.y));
  vec4 b = texture(tex, vec2(o1.x, o0.y));
  vec4 c = texture(tex, vec2(o0.x, o1.y));
  vec4 d = texture(tex, vec2(o1.x, o1.y));

  return mix(mix(a, b, s1.x / (s0.x + s1.x)),
             mix(c, d, s1.x / (s0.x + s1.x)),
             s1.y / (s0.y + s1.y));
}
`

/**
 * 合成 pass：取樣 A/B、線性化、依比對模式混合，寫入 half-float FBO。
 *
 * A 與 B 都用同一組 normalized UV 取樣，所以解析度不同會自動對齊 —— 這正是
 * upscale 比對的情境（512 vs 2048），而放大方式由 uInterp 決定，不是隱含行為。
 */
export const COMPOSITE_SHADER = COMMON + `
out vec4 fragColor;

uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform vec2 uSizeA;
uniform vec2 uSizeB;
uniform int uTfA;
uniform int uTfB;

// pane 在畫布上的矩形（像素），用來把 gl_FragCoord 換算成 pane 內的座標。
uniform vec4 uPaneRect;
// stage（比對舞台）在 pane 內的實際顯示矩形，已做 contain 處理。
uniform vec4 uStageRect;

uniform int uMode;
uniform int uInterp;

// slider：分割線的位置與角度。rotate 是分割線本身的角度，不是內容旋轉。
uniform float uSplitPos;
uniform float uSplitAngle;
uniform float uSplitWidth;
uniform float uSplitLinePx;
uniform vec3 uSplitLineColor;
uniform float uSplitPivotPx;

uniform float uDiffGain;
uniform int uShowSource;   // MODE_SINGLE 時顯示哪一邊：0 = A、1 = B

const int MODE_SINGLE = 0;
const int MODE_SLIDER = 1;
const int MODE_DIFF   = 2;

const int INTERP_NEAREST  = 0;
const int INTERP_BILINEAR = 1;
const int INTERP_BICUBIC  = 2;

vec4 sampleSource(sampler2D tex, vec2 uv, vec2 texSize) {
  if (uInterp == INTERP_BICUBIC) return sampleBicubic(tex, uv, texSize);
  // NEAREST 與 BILINEAR 由 texture filter 參數決定，這裡走同一條路。
  return texture(tex, uv);
}

void main() {
  vec2 paneXY = gl_FragCoord.xy - uPaneRect.xy;

  // 換算成 stage 的 normalized UV。超出 stage 的部分是 letterbox。
  vec2 uv = (paneXY - uStageRect.xy) / uStageRect.zw;
  uv.y = 1.0 - uv.y;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 a = toLinear(sampleSource(uTexA, uv, uSizeA).rgb, uTfA);
  vec3 b = toLinear(sampleSource(uTexB, uv, uSizeB).rgb, uTfB);

  vec3 result;

  if (uMode == MODE_SINGLE) {
    result = (uShowSource == 0) ? a : b;

  } else if (uMode == MODE_SLIDER) {
    // 以 stage 中心為原點，把座標投影到分割線的法線上。
    vec2 centered = (uv - 0.5);
    // 補正長寬比，讓分割線的角度是視覺上的角度而不是被拉伸過的。
    // 補正後 x 與 y 同尺度：一個單位都等於 stage 的高度（像素）。
    float aspect = uStageRect.z / uStageRect.w;
    centered.x *= aspect;

    vec2 normal = vec2(cos(uSplitAngle), sin(uSplitAngle));

    // uSplitPos 的 0 與 1 必須真的對應到畫面兩端。
    // 位移量的尺度要跟著補正後的座標走：把 stage 的半尺寸投影到法線上，
    // 才是分割線能移動的實際半徑。少了這一步，16:9 的畫面 0~1 只能掃到中間約 56%。
    float halfExtent = abs(normal.x) * (aspect * 0.5) + abs(normal.y) * 0.5;
    float offset = (uSplitPos * 2.0 - 1.0) * halfExtent;

    float d = dot(centered, normal) - offset;

    // smoothstep 讓分割線邊緣不出現鋸齒。寬度為 0 時退化成硬切。
    float t = uSplitWidth > 0.0 ? smoothstep(-uSplitWidth, uSplitWidth, d) : step(0.0, d);
    result = mix(a, b, t);

    // 畫出可見的分割線。沒有這條線就抓不到它，也看不出角度。
    if (uSplitLinePx > 0.0) {
      float halfWidth = uSplitLinePx * 0.5 / uStageRect.w;
      float edge = 1.0 / uStageRect.w;
      float onLine = 1.0 - smoothstep(halfWidth - edge, halfWidth + edge, abs(d));
      result = mix(result, uSplitLineColor, onLine);
    }

    // 旋轉中心點：分割線上離畫面中心最近的那一點，也就是旋轉的支點。
    // 畫出來使用者才知道會繞著哪裡轉，不然旋轉的手感會很不可預期。
    if (uSplitPivotPx > 0.0) {
      vec2 pivot = normal * offset;
      float radius = uSplitPivotPx * 0.5 / uStageRect.w;
      float edge = 1.0 / uStageRect.w;
      float distanceToPivot = length(centered - pivot);
      float onPivot = 1.0 - smoothstep(radius - edge, radius + edge, distanceToPivot);
      // 中心點畫成空心環，才不會擋住支點底下的畫面內容。
      float inner = 1.0 - smoothstep(radius * 0.45 - edge, radius * 0.45 + edge, distanceToPivot);
      result = mix(result, uSplitLineColor, max(0.0, onPivot - inner));
    }

  } else {
    // 差異模式：在線性光下取絕對差再放大。
    // 在 sRGB 編碼值上做差會讓暗部差異被過度放大，那是編碼曲線的假象而非真實差異。
    result = abs(a - b) * uDiffGain;
  }

  fragColor = vec4(result, 1.0);
}
`

/**
 * 輸出 pass：線性 → 顯示編碼。
 *
 * ACES ODT 的接入點。目前預設走 identity（線性 → sRGB 編碼），
 * 讓「輸入 sRGB → 線性 → 輸出 sRGB」是可驗證的無損來回，
 * 這也是 T001 那個全黑 diff 驗收項成立的前提。
 */
export const OUTPUT_SHADER = COMMON + `
out vec4 fragColor;

uniform sampler2D uTex;
uniform int uOutputTf;
uniform int uToneMap;   // 0 = 不套用（預設）、1 = ACES 近似

const int TONEMAP_NONE = 0;

// Narkowicz 的 ACES filmic 近似。放在這裡是為了佔住 ODT 的位置並驗證管線可換，
// 不是最終的 ACES 實作 —— 真正的 RRT+ODT 需要 3D LUT。
// 預設關閉：比對工具不該偷偷改變使用者看到的像素值。
vec3 acesApprox(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 linear = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0).rgb;

  if (uToneMap != TONEMAP_NONE) {
    linear = acesApprox(linear);
  }

  fragColor = vec4(fromLinear(clamp(linear, 0.0, 1.0), uOutputTf), 1.0);
}
`
