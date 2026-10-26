# 3D & shaders

Use the existing OpenUI expression syntax for scene functions. Scene expressions cannot execute JavaScript or access the network. Models must embed every buffer and texture; external model references are refused.

## Scene

`Scene(objects: Record<string, any>[] | string, height?: number, camera?: {yaw?: number, pitch?: number, zoom?: number}, spin?: number, animate?: boolean, orbit?: boolean, inputs?: Record<string, any>)`

Interactive 3D scene. Objects use shape: box, sphere, cylinder, surface, mesh, line, path, point, label, grid, axes, model, environment, sprite. Positions use at:[x,y,z], with y up. Materials take color (theme token or #rrggbb), roughness, metal, glow, glass, ior, dispersion, texture. Model src is a local embedded GLB/glTF; environment src is HDR or an image. A surface uses x:[min,max], z:[min,max], values:height rows or f:a quoted OpenUI expression such as "@Sin($x)*@Cos($z)". objects may be a quoted array expression using $t in seconds. Named inputs are available as $name. Use @Sin/@Cos and the native OpenUI math functions, never JavaScript. Orbit by drag, pinch or ctrl-wheel; double-click resets. GPU contexts pause off screen. System reduced motion and Pages Animations apply.

Solids and labels:

```openui-lang
root = Scene([{shape: "box", at: [-1, 0.5, 0], size: 1, color: "accent"}, {shape: "sphere", at: [0.7, 0.65, 0], radius: 0.65, color: "chart3", metal: 0.3}, {shape: "grid", size: 5}, {shape: "axes", size: 2}, {shape: "label", at: [-1, 1.3, 0], text: "Box"}])
```

Sampled surface:

```openui-lang
root = Scene([{shape: "surface", x: [-3, 3], z: [-3, 3], f: "@Sin($x) * @Cos($z)", detail: 40, colors: ["chart2", "accent", "chart3"]}, {shape: "axes", size: 3}], 320)
```

Animated orbit:

```openui-lang
root = Scene("[{shape: \"sphere\", at: [@Cos($t) * 1.2, 0.6, @Sin($t) * 1.2], radius: 0.4, color: \"accent\"}, {shape: \"sphere\", at: [0, 0.6, 0], radius: 0.25, color: \"chart4\", glow: 0.5}, {shape: \"grid\", size: 4}]", 280)
```

Glass and glow:

```openui-lang
root = Scene([{shape: "sphere", at: [-0.8, 0.7, 0], radius: 0.7, color: "accent", glass: true, roughness: 0.05}, {shape: "box", at: [0.8, 0.5, 0], color: "chart4", glow: 0.8}, {shape: "grid", size: 5}], 280)
```

## Shader

`Shader(code: string, height?: number, inputs?: Record<string, number | boolean>, buffers?: string[], textures?: string[], animate?: boolean, blend?: "light" | "alpha" | "opaque", bloom?: number, orbit?: boolean, spin?: number, camera?: {yaw?: number, pitch?: number, zoom?: number})`

Shadertoy-style WebGL2 shader: code defines void mainImage(out vec4 fragColor, in vec2 fragCoord). Uniforms include iResolution, iTime, iTimeDelta, iFrame, iMouse, iCamera, iNoise. Named inputs become float uniforms; booleans are 0/1. Up to four buffers run before the image, with ping-pong feedback as iChannel0-3; textures are iTexture0-3. Inputs update uniforms without recompilation. blend is light (black transparent), alpha, or opaque; bloom preserves HDR light. Optional orbit camera, spin, and live height. Rendering pauses off screen and respects reduced motion. No network from shaders; textures load through Pages.

Animated light:

```openui-lang
root = Shader("void mainImage(out vec4 c, in vec2 p) { vec2 uv = (p - 0.5 * iResolution.xy) / iResolution.y; float light = 0.02 / max(0.015, abs(length(uv) - 0.2 - 0.04 * sin(iTime))); c = vec4(vec3(0.2, 0.55, 1.0) * light, 1.0); }", 240)
```

Live input:

```openui-lang
$speed = 1
root = Stack([Slider("speed", 0, 3, 0.1, "Speed", $speed), Shader("void mainImage(out vec4 c, in vec2 p) { vec2 uv = p / iResolution.xy; c = vec4(0.5 + 0.5 * cos(iTime * speed + uv.xyx * 6.0 + vec3(0.0, 2.0, 4.0)), 1.0); }", 220, {speed: $speed}, [], [], true, "opaque")])
```

Feedback buffer:

```openui-lang
root = Shader("void mainImage(out vec4 c, in vec2 p) { c = texture(iChannel0, p / iResolution.xy); }", 220, {}, ["void mainImage(out vec4 c, in vec2 p) { vec2 uv = p / iResolution.xy; vec3 previous = texture(iChannel0, uv).rgb * 0.96; vec2 center = 0.5 + 0.25 * vec2(cos(iTime), sin(iTime * 1.3)); float dotLight = exp(-500.0 * dot(uv - center, uv - center)); c = vec4(previous + dotLight * vec3(0.1, 0.4, 0.8), 1.0); }"])
```
