// Cycle Rush — draws a match state onto a 2D canvas. Reads nothing but `s`.
import { FIELD, HUBS, HUB_SOLID, HUB_SCORE, DOCKS, CHUTES, R_ROBOT, R_BALL, CAPACITY, SHOT_SPEED, FLIGHT, MATCH } from './engine'

/** Canvas cannot read CSS variables, so the page samples the tokens once. */
export function readPalette(el) {
  const cs = getComputedStyle(el)
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback
  return {
    floor: v('--surface-sunken', '#0a0a0b'),
    line: v('--border-strong', 'rgba(255,255,255,0.14)'),
    hairline: v('--border-hairline', 'rgba(255,255,255,0.08)'),
    blue: v('--accent-data', '#5b9bea'),
    blueDeep: v('--brand-royal', '#144781'),
    red: v('--danger', '#f06363'),
    gold: v('--accent-gold', '#d9c68a'),
    goldHi: v('--accent-gold-hi', '#ecdfb4'),
    frame: v('--surface-2', '#16181b'),
    text: v('--text-primary', '#f4f5f7'),
    muted: v('--text-muted', '#8d8f96'),
    font: v('--font-display', 'system-ui'),
  }
}

const alpha = (hex, a) => {
  if (!hex.startsWith('#') || hex.length !== 7) return hex
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/**
 * @param ctx 2D context of a canvas sized cssW*dpr × cssH*dpr
 * @param view { cssW, dpr, pal, aim: boolean, sticks: [{x,y,dx,dy}] in css px }
 */
export function drawGame(ctx, s, view) {
  const { cssW, dpr, pal } = view
  const k = cssW / FIELD.w
  const px = k * dpr
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.setTransform(px, 0, 0, px, 0, 0)

  const text = (str, x, y, size, color, weight = 600) => {
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(1 / k, 1 / k)
    ctx.fillStyle = color
    ctx.font = `${weight} ${size}px ${pal.font}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(str, 0, 0)
    ctx.restore()
  }

  // --- floor, zones, lines
  ctx.fillStyle = pal.floor
  ctx.fillRect(0, 0, FIELD.w, FIELD.h)
  const zone = (x, color) => {
    const g = ctx.createLinearGradient(x === 0 ? 0 : FIELD.w, 0, FIELD.w / 2, 0)
    g.addColorStop(0, alpha(color, 0.1))
    g.addColorStop(1, alpha(color, 0))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, FIELD.w, FIELD.h)
  }
  zone(0, pal.blue)
  zone(FIELD.w, pal.red)
  ctx.strokeStyle = pal.hairline
  ctx.lineWidth = 0.02
  for (let x = 1; x < FIELD.w; x++) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, FIELD.h); ctx.stroke() }
  for (let y = 1; y < FIELD.h; y++) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(FIELD.w, y); ctx.stroke() }
  ctx.strokeStyle = pal.line
  ctx.lineWidth = 0.05
  ctx.beginPath(); ctx.moveTo(FIELD.w / 2, 0); ctx.lineTo(FIELD.w / 2, FIELD.h); ctx.stroke()
  ctx.strokeRect(0.025, 0.025, FIELD.w - 0.05, FIELD.h - 0.05)

  // --- docks (glow in the endgame)
  const endgame = s.phase === 'endgame'
  const pulse = endgame ? 0.25 + 0.2 * Math.sin(s.clock * 6) : 0.12
  for (const [team, d] of Object.entries(DOCKS)) {
    const c = team === 'blue' ? pal.blue : pal.red
    ctx.fillStyle = alpha(c, pulse)
    ctx.fillRect(d.x, d.y, d.w, d.h)
    ctx.strokeStyle = alpha(c, 0.7)
    ctx.lineWidth = 0.04
    ctx.strokeRect(d.x + 0.02, d.y, d.w - 0.04, d.h)
    ctx.save()
    ctx.beginPath(); ctx.rect(d.x, d.y, d.w, d.h); ctx.clip()
    ctx.strokeStyle = alpha(c, 0.25)
    for (let i = -3; i < 6; i++) {
      ctx.beginPath(); ctx.moveTo(d.x + i * 0.4, d.y); ctx.lineTo(d.x + i * 0.4 + d.h, d.y + d.h); ctx.stroke()
    }
    ctx.restore()
    text('DOCK', d.x + d.w / 2, d.y - 0.22, 11, alpha(c, 0.9))
  }

  // --- return chutes
  for (const c of CHUTES) {
    ctx.fillStyle = alpha(pal.gold, 0.18)
    ctx.fillRect(c.x - 0.4, c.dir > 0 ? 0 : FIELD.h - 0.18, 0.8, 0.18)
  }

  // --- hubs
  for (const [team, h] of Object.entries(HUBS)) {
    const c = team === 'blue' ? pal.blue : pal.red
    const g = ctx.createRadialGradient(h.x, h.y, 0.2, h.x, h.y, HUB_SOLID + 0.6)
    g.addColorStop(0, alpha(c, 0.35))
    g.addColorStop(1, alpha(c, 0))
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(h.x, h.y, HUB_SOLID + 0.6, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = pal.frame
    ctx.beginPath(); ctx.arc(h.x, h.y, HUB_SOLID, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = c
    ctx.lineWidth = 0.08
    ctx.stroke()
    ctx.fillStyle = alpha(c, 0.25)
    ctx.beginPath(); ctx.arc(h.x, h.y, HUB_SCORE * 0.7, 0, Math.PI * 2); ctx.fill()
  }

  // --- ground balls under robots
  for (const b of s.balls) {
    if (b.air) continue
    ctx.fillStyle = pal.gold
    ctx.beginPath(); ctx.arc(b.x, b.y, R_BALL, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = alpha('#ffffff', 0.35)
    ctx.beginPath(); ctx.arc(b.x - 0.035, b.y - 0.035, R_BALL * 0.35, 0, Math.PI * 2); ctx.fill()
  }

  // --- player's aim line
  const p = s.robots.find((r) => r.isPlayer)
  if (p && view.aim && p.carry > 0 && s.phase !== 'over') {
    const c = Math.cos(p.heading)
    const sn = Math.sin(p.heading)
    const vx = c * SHOT_SPEED + p.vx
    const vy = sn * SHOT_SPEED + p.vy
    ctx.strokeStyle = alpha(pal.gold, 0.45)
    ctx.lineWidth = 0.035
    ctx.setLineDash([0.15, 0.15])
    ctx.beginPath()
    ctx.moveTo(p.x + c * R_ROBOT, p.y + sn * R_ROBOT)
    ctx.lineTo(p.x + c * R_ROBOT + vx * FLIGHT, p.y + sn * R_ROBOT + vy * FLIGHT)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // --- robots
  for (const r of s.robots) {
    const c = r.team === 'blue' ? pal.blue : pal.red
    const half = R_ROBOT * 0.92
    ctx.save()
    ctx.translate(r.x, r.y)
    if (r.isPlayer) {
      ctx.strokeStyle = alpha(pal.gold, 0.6)
      ctx.lineWidth = 0.04
      ctx.beginPath(); ctx.arc(0, 0, R_ROBOT + 0.14, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.rotate(r.heading)
    // bumpers
    ctx.fillStyle = c
    roundRect(ctx, -half, -half, half * 2, half * 2, 0.1)
    ctx.fill()
    // frame
    ctx.fillStyle = pal.frame
    roundRect(ctx, -half + 0.1, -half + 0.1, half * 2 - 0.2, half * 2 - 0.2, 0.05)
    ctx.fill()
    // swerve modules
    ctx.fillStyle = alpha('#ffffff', 0.18)
    for (const [mx, my] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      ctx.beginPath(); ctx.arc(mx * (half - 0.2), my * (half - 0.2), 0.07, 0, Math.PI * 2); ctx.fill()
    }
    // intake on the front
    ctx.fillStyle = pal.goldHi
    ctx.fillRect(half - 0.06, -half * 0.75, 0.1, half * 1.5)
    ctx.restore()
    text(r.label, r.x, r.y, r.isPlayer ? 11 : 10, pal.text, 700)
    // carried balls as pips
    for (let i = 0; i < CAPACITY; i++) {
      ctx.fillStyle = i < r.carry ? pal.gold : alpha('#ffffff', 0.12)
      ctx.beginPath()
      ctx.arc(r.x - 0.3 + i * 0.15, r.y + R_ROBOT + 0.2, 0.05, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // --- shots in the air, over everything
  for (const b of s.balls) {
    if (!b.air) continue
    ctx.fillStyle = alpha('#000000', 0.35)
    ctx.beginPath(); ctx.arc(b.x, b.y, R_BALL, 0, Math.PI * 2); ctx.fill()
    const lift = b.z * 0.5
    ctx.fillStyle = pal.goldHi
    ctx.beginPath(); ctx.arc(b.x, b.y - lift, R_BALL * (1 + b.z * 0.5), 0, Math.PI * 2); ctx.fill()
  }

  // --- score pop-ups
  for (const pop of s.popups) {
    const a = 1 - pop.t / 1.1
    text(pop.text, pop.x, pop.y - pop.t * 0.6, 16, alpha(pop.team === 'blue' ? pal.blue : pal.red, a), 700)
  }

  // --- countdown
  if (s.phase === 'countdown') {
    ctx.fillStyle = alpha('#000000', 0.35)
    ctx.fillRect(0, 0, FIELD.w, FIELD.h)
    text(String(Math.ceil(-s.clock)), FIELD.w / 2, FIELD.h / 2, 72, pal.text, 700)
  } else if (s.clock < MATCH.auto && s.clock < 1.2) {
    text('AUTO — DOUBLE POINTS', FIELD.w / 2, FIELD.h / 2, 26, alpha(pal.gold, 1 - s.clock / 1.2), 700)
  } else if (s.phase === 'endgame' && s.clock < MATCH.total - MATCH.endgame + 1.5) {
    text('ENDGAME — GET TO THE DOCK', FIELD.w / 2, FIELD.h / 2, 26, pal.gold, 700)
  }

  // --- touch sticks, in css pixels
  if (view.sticks?.length) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    for (const st of view.sticks) {
      ctx.strokeStyle = alpha('#ffffff', 0.25)
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(st.x, st.y, 44, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = alpha('#ffffff', 0.25)
      ctx.beginPath(); ctx.arc(st.x + st.dx * 44, st.y + st.dy * 44, 18, 0, Math.PI * 2); ctx.fill()
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
