import { useEffect, useRef } from 'react'
import Section from './Section'
import Eyebrow from './Eyebrow'
import SplitHeading from './SplitHeading'
import Reveal from './Reveal'
import { prefersReducedMotion } from '../lib/prefersReducedMotion'
import styles from './SwerveDemo.module.css'

// --- math helpers ---------------------------------------------------------
const TAU = Math.PI * 2
// Shortest signed angular distance from a to b, in (-PI, PI].
function angleDelta(a, b) {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}
const lerp = (a, b, t) => a + (b - a) * t

/**
 * Interactive top-down swerve-drive demo. A rounded-square chassis with four
 * independently-steering modules; each pod rotates to point at the pointer, and
 * the chassis itself eases a touch toward it. Pure canvas, design-token colored,
 * DPR-crisp, RAF with angle-lerp, paused off-screen. Static neat pose under
 * reduced-motion.
 */
export default function SwerveDemo() {
  const stageRef = useRef(null)
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Resolve design tokens off the live DOM so the canvas tracks the theme.
    const cs = getComputedStyle(stage)
    const token = (name, fallback) =>
      (cs.getPropertyValue(name) || '').trim() || fallback
    const C = {
      data: token('--accent-data', '#38bdf8'),
      gold: token('--accent-gold', '#f5b82e'),
      muted: token('--text-muted', '#8499ae'),
      surface: token('--surface-1', '#0e2a4d'),
      sunken: token('--surface-sunken', '#081a30'),
      hair: token('--border-strong', 'rgba(199,210,221,0.18)'),
    }

    const reduced = prefersReducedMotion()

    // Logical (CSS-pixel) size, kept in sync by fit().
    let W = 0
    let H = 0
    let dpr = 1

    // Pointer target in logical px; default to top-center (a forward heading).
    const pointer = { x: 0, y: 0, active: false }

    // Per-module live + target steer angles (radians). Chassis pose state.
    const steer = [0, 0, 0, 0]
    const steerTarget = [0, 0, 0, 0]
    let bodyAngle = 0
    let bodyAngleTarget = 0
    let bodyX = 0 // offset from center (logical px)
    let bodyY = 0
    let bodyXTarget = 0
    let bodyYTarget = 0

    function fit() {
      const rect = stage.getBoundingClientRect()
      W = Math.max(1, rect.width)
      H = Math.max(1, rect.height)
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!pointer.active) {
        pointer.x = W / 2
        pointer.y = H * 0.12
      }
      if (reduced) draw() // single static paint
    }

    // Chassis geometry derived from the current logical size.
    function geom() {
      const cx = W / 2 + bodyX
      const cy = H / 2 + bodyY
      const size = Math.min(W, H) * 0.46
      const half = size / 2
      const inset = size * 0.2 // module distance from chassis edge inward
      const corners = [
        [-half + inset, -half + inset], // FL
        [half - inset, -half + inset], // FR
        [-half + inset, half - inset], // RL
        [half - inset, half - inset], // RR
      ]
      return { cx, cy, half, size, corners, mod: size * 0.16 }
    }

    function updateTargets() {
      const g = geom()
      // Each module steers toward the pointer, expressed in the chassis frame
      // so steering is correct even as the body rotates.
      for (let i = 0; i < 4; i++) {
        const [lx, ly] = g.corners[i]
        // module world position (account for body rotation)
        const cos = Math.cos(bodyAngle)
        const sin = Math.sin(bodyAngle)
        const wx = g.cx + lx * cos - ly * sin
        const wy = g.cy + lx * sin + ly * cos
        const world = Math.atan2(pointer.y - wy, pointer.x - wx)
        steerTarget[i] = world - bodyAngle // back into chassis frame
      }
      // Subtle whole-body lean toward the pointer (clamped, never far).
      const dx = pointer.x - W / 2
      const dy = pointer.y - H / 2
      const maxShift = Math.min(W, H) * 0.05
      const mag = Math.hypot(dx, dy) || 1
      bodyXTarget = (dx / mag) * Math.min(maxShift, mag * 0.05)
      bodyYTarget = (dy / mag) * Math.min(maxShift, mag * 0.05)
      bodyAngleTarget = Math.atan2(dy, dx + W) * 0.18 // very gentle yaw
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r)
      ctx.arcTo(x, y, x + w, y, r)
      ctx.closePath()
    }

    function drawModule(angle, mod) {
      ctx.save()
      ctx.rotate(angle)
      // pod housing
      ctx.fillStyle = C.sunken
      ctx.strokeStyle = C.data
      ctx.lineWidth = 1.4
      ctx.globalAlpha = 0.95
      roundRect(-mod * 0.62, -mod * 0.62, mod * 1.24, mod * 1.24, mod * 0.28)
      ctx.fill()
      ctx.stroke()
      // wheel (a capsule pointing +x = steer direction)
      ctx.globalAlpha = 1
      ctx.fillStyle = C.data
      roundRect(-mod * 0.16, -mod * 0.5, mod * 0.32, mod, mod * 0.16)
      ctx.fill()
      // direction tick — small cyan nub at the leading edge
      ctx.beginPath()
      ctx.arc(mod * 0.78, 0, mod * 0.12, 0, TAU)
      ctx.fillStyle = C.data
      ctx.fill()
      ctx.restore()
    }

    function draw() {
      ctx.clearRect(0, 0, W, H)
      const g = geom()

      // faint pointer crosshair line from chassis center
      if (pointer.active) {
        ctx.save()
        ctx.strokeStyle = C.hair
        ctx.lineWidth = 1
        ctx.setLineDash([3, 5])
        ctx.beginPath()
        ctx.moveTo(g.cx, g.cy)
        ctx.lineTo(pointer.x, pointer.y)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.arc(pointer.x, pointer.y, 4, 0, TAU)
        ctx.fillStyle = C.gold
        ctx.fill()
        ctx.restore()
      }

      ctx.save()
      ctx.translate(g.cx, g.cy)
      ctx.rotate(bodyAngle)

      // chassis plate
      roundRect(-g.half, -g.half, g.size, g.size, g.size * 0.12)
      ctx.fillStyle = C.surface
      ctx.fill()
      ctx.lineWidth = 1.6
      ctx.strokeStyle = C.muted
      ctx.stroke()

      // inner blueprint frame
      ctx.save()
      ctx.globalAlpha = 0.5
      ctx.strokeStyle = C.hair
      ctx.lineWidth = 1
      const ph = g.half - g.size * 0.1
      roundRect(-ph, -ph, ph * 2, ph * 2, g.size * 0.08)
      ctx.stroke()
      ctx.restore()

      // front indicator — the single gold accent (chassis "nose", top edge)
      ctx.fillStyle = C.gold
      ctx.beginPath()
      ctx.moveTo(0, -g.half - g.size * 0.06)
      ctx.lineTo(-g.size * 0.07, -g.half + g.size * 0.02)
      ctx.lineTo(g.size * 0.07, -g.half + g.size * 0.02)
      ctx.closePath()
      ctx.fill()

      // modules
      for (let i = 0; i < 4; i++) {
        const [lx, ly] = g.corners[i]
        ctx.save()
        ctx.translate(lx, ly)
        drawModule(steer[i], g.mod)
        ctx.restore()
      }

      ctx.restore()
    }

    // --- animation loop ----------------------------------------------------
    let raf = 0
    let running = false

    function frame() {
      updateTargets()
      for (let i = 0; i < 4; i++) {
        steer[i] += angleDelta(steer[i], steerTarget[i]) * 0.16
      }
      bodyAngle += angleDelta(bodyAngle, bodyAngleTarget) * 0.08
      bodyX = lerp(bodyX, bodyXTarget, 0.08)
      bodyY = lerp(bodyY, bodyYTarget, 0.08)
      draw()
      raf = requestAnimationFrame(frame)
    }

    function start() {
      if (running || reduced) return
      running = true
      raf = requestAnimationFrame(frame)
    }
    function stop() {
      running = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }

    // --- pointer input -----------------------------------------------------
    function setPointer(clientX, clientY) {
      const rect = stage.getBoundingClientRect()
      pointer.x = clientX - rect.left
      pointer.y = clientY - rect.top
      pointer.active = true
      if (reduced) {
        // honor input even without a loop: one repaint toward target
        updateTargets()
        for (let i = 0; i < 4; i++) steer[i] = steerTarget[i]
        draw()
      }
    }
    const onMove = (e) => setPointer(e.clientX, e.clientY)
    const onTouch = (e) => {
      if (!e.touches.length) return
      setPointer(e.touches[0].clientX, e.touches[0].clientY)
    }
    const onLeave = () => {
      pointer.active = false
      pointer.x = W / 2
      pointer.y = H * 0.12
    }

    stage.addEventListener('pointermove', onMove)
    stage.addEventListener('pointerleave', onLeave)
    stage.addEventListener('touchmove', onTouch, { passive: true })
    stage.addEventListener('touchstart', onTouch, { passive: true })

    // --- responsive fit + off-screen pause --------------------------------
    let ro = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => fit())
      ro.observe(stage)
    } else {
      window.addEventListener('resize', fit)
    }

    let io = null
    if (!reduced && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((en) => (en.isIntersecting ? start() : stop()))
        },
        { threshold: 0.05 }
      )
      io.observe(stage)
    }

    fit()
    if (reduced) {
      draw() // neat default pose, modules forward
    } else if (!io) {
      start()
    }

    return () => {
      stop()
      stage.removeEventListener('pointermove', onMove)
      stage.removeEventListener('pointerleave', onLeave)
      stage.removeEventListener('touchmove', onTouch)
      stage.removeEventListener('touchstart', onTouch)
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', fit)
      if (io) io.disconnect()
    }
  }, [])

  return (
    <Section id="drive">
      <div className={styles.layout}>
        {/* Left: editorial explainer */}
        <div className={styles.copy}>
          <Eyebrow>How it moves</Eyebrow>
          <SplitHeading as="h2" className={styles.heading}>
            Swerve drive, demystified.
          </SplitHeading>

          <Reveal className={styles.body} stagger={0.1} y={24}>
            <p className="lead">
              Each wheel sits on its own steerable pod, so all four can point any
              direction at once. The robot can <strong>translate any way while
              facing any way</strong> — strafe, spin, and drive on independent
              axes. It&apos;s the drivetrain on our competition robots, and it&apos;s
              what makes a modern FRC machine feel agile on the field.
            </p>
            <p className={styles.hintLine}>
              Move your cursor across the chassis and watch every module steer to
              follow — exactly how a driver commands it.
            </p>
            <div className={styles.specs}>
              <span className="data-tag">4× independent modules</span>
              <span className="data-tag">3 DOF · X / Y / YAW</span>
              <span className="data-tag data-tag--gold">FRONT // GOLD MARK</span>
            </div>
          </Reveal>
        </div>

        {/* Right: interactive canvas in a HUD frame */}
        <Reveal className={styles.stageWrap} y={28} duration={0.9}>
          <div className={`hud-frame ${styles.stageFrame}`}>
            <div className={styles.stageHead}>
              <span className={styles.stageDot} aria-hidden="true" />
              <span className={styles.stageTitle}>SWERVE&nbsp;//&nbsp;LIVE</span>
              <span className={styles.stageHint}>drag / move your cursor</span>
            </div>
            <div ref={stageRef} className={styles.stage}>
              <canvas
                ref={canvasRef}
                className={styles.canvas}
                role="img"
                aria-label="Interactive top-down diagram of a four-module swerve drivetrain; the modules steer toward your cursor."
              />
              <span className={styles.axisX} aria-hidden="true" />
              <span className={styles.axisY} aria-hidden="true" />
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  )
}
