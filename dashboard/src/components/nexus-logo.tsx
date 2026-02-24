'use client'

import { useEffect, useRef, useCallback } from 'react'

interface NexusLogoProps {
    size?: number
    className?: string
}

interface CircuitPath {
    points: { x: number; y: number }[]
    progress: number
    speed: number
    color: { r: number; g: number; b: number }
}

interface EnergyLine {
    x1: number
    y1: number
    x2: number
    y2: number
    alpha: number
    fadeDirection: number
}

export function NexusLogo({ size = 200, className = '' }: NexusLogoProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const animationRef = useRef<number>(0)
    const circuitPathsRef = useRef<CircuitPath[]>([])
    const energyLinesRef = useRef<EnergyLine[]>([])
    const timeRef = useRef(0)

    const generateCircuitPath = useCallback((
        startX: number,
        startY: number,
        endX: number,
        endY: number,
        jitterAmount: number = 0.04,
        numSegments: number = 5
    ): { x: number; y: number }[] => {
        const points: { x: number; y: number }[] = [{ x: startX, y: startY }]
        let currX = startX
        let currY = startY

        for (let i = 0; i < numSegments; i++) {
            const ratio = (i + 1) / numSegments
            const targetX = startX + (endX - startX) * ratio
            const targetY = startY + (endY - startY) * ratio

            // Decide whether to move horizontally or vertically
            const jitter = size * jitterAmount
            let nextX: number, nextY: number

            // Draw straighter lines by defaulting to exact grid points often
            if (Math.random() > 0.5) {
                // Move X then Y or vice versa
                if (Math.random() > 0.5) {
                    nextX = targetX + (Math.random() - 0.5) * jitter
                    nextY = currY
                } else {
                    nextX = currX
                    nextY = targetY + (Math.random() - 0.5) * jitter
                }
            } else {
                // Direct bias towards target
                nextX = targetX
                nextY = targetY
            }

            points.push({ x: nextX, y: nextY })
            currX = nextX
            currY = nextY
        }

        points.push({ x: endX, y: endY })
        return points
    }, [size])

    const initializeEffects = useCallback(() => {
        const cx = size / 2
        const cy = size / 2
        const orbRadius = size * 0.12

        // Generate circuit paths forming a clear 'N' structure
        const paths: CircuitPath[] = []

        // N dimensions - A more vertical, narrower N
        const nWidth = size * 0.45
        const nHeight = size * 0.50 // Made shorter (was 0.65)
        const nLeft = cx - nWidth / 2
        const nRight = cx + nWidth / 2
        const nTop = cy - nHeight / 2
        const nBottom = cy + nHeight / 2

        // Helper to add a stroke
        const addStroke = (x1: number, y1: number, x2: number, y2: number, count: number, jitter: number, colorShift: number) => {
            for (let i = 0; i < count; i++) {
                // Slight offset for parallel lines
                const offsetX = (Math.random() - 0.5) * (size * 0.02)
                const offsetY = (Math.random() - 0.5) * (size * 0.02)

                paths.push({
                    points: generateCircuitPath(x1 + offsetX, y1 + offsetY, x2 + offsetX, y2 + offsetY, jitter, 4),
                    progress: Math.random(),
                    speed: 0.002 + Math.random() * 0.003,
                    color: { r: 10, g: 200 + Math.random() * 55, b: 180 + Math.random() * 75 } // Cyan/Emerald theme
                })
            }
        }

        // === LEFT VERTICAL STROKE (bottom to top) ===
        // Main solid beam
        addStroke(nLeft, nBottom, nLeft, nTop, 3, 0.005, 0)
        // Decorators
        addStroke(nLeft - size * 0.025, nBottom, nLeft - size * 0.025, nTop, 1, 0.015, 0)
        addStroke(nLeft + size * 0.015, nBottom, nLeft + size * 0.015, nTop, 1, 0.015, 0) // New inner line

        // === DIAGONAL STROKE (top-left to bottom-right) ===
        // Main solid beam
        addStroke(nLeft, nTop, nRight, nBottom, 3, 0.005, 20)
        // Decorators
        addStroke(nLeft, nTop + size * 0.02, nRight, nBottom + size * 0.02, 1, 0.005, 20)
        // Faint back-diagonal for complexity
        addStroke(nLeft + size * 0.02, nTop, nRight - size * 0.02, nBottom, 1, 0.01, 20)

        // === RIGHT VERTICAL STROKE (top to bottom) ===
        // Main solid beam
        addStroke(nRight, nTop, nRight, nBottom, 3, 0.005, 40)
        // Decorators 
        addStroke(nRight + size * 0.025, nTop, nRight + size * 0.025, nBottom, 1, 0.015, 40)
        addStroke(nRight - size * 0.015, nTop, nRight - size * 0.015, nBottom, 1, 0.015, 40) // New inner line

        circuitPathsRef.current = paths

        // Generate energy lines within the orb
        const lines: EnergyLine[] = []
        for (let i = 0; i < 8; i++) {
            lines.push({
                x1: cx + (Math.random() - 0.5) * orbRadius * 1.5,
                y1: cy + (Math.random() - 0.5) * orbRadius * 1.5,
                x2: cx + (Math.random() - 0.5) * orbRadius * 1.5,
                y2: cy + (Math.random() - 0.5) * orbRadius * 1.5,
                alpha: Math.random(),
                fadeDirection: Math.random() > 0.5 ? 1 : -1
            })
        }
        energyLinesRef.current = lines
    }, [size, generateCircuitPath])

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return

        const ctx = canvas.getContext('2d')
        if (!ctx) return

        // Set up high DPI canvas
        const dpr = window.devicePixelRatio || 1
        canvas.width = size * dpr
        canvas.height = size * dpr
        ctx.scale(dpr, dpr)

        initializeEffects()

        const animate = () => {
            timeRef.current += 0.016 // ~60fps

            // Clear canvas
            ctx.clearRect(0, 0, size, size)

            const cx = size / 2
            const cy = size / 2
            const orbRadius = size * 0.12

            // Draw outer glow
            const glowGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbRadius * 3)
            const glowPulse = 0.3 + Math.sin(timeRef.current * 2) * 0.1
            glowGradient.addColorStop(0, `rgba(16, 185, 129, ${glowPulse})`)
            glowGradient.addColorStop(0.5, `rgba(59, 130, 246, ${glowPulse * 0.3})`)
            glowGradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
            ctx.fillStyle = glowGradient
            ctx.fillRect(0, 0, size, size)

            // Draw circuit paths with animated pulses
            circuitPathsRef.current.forEach(path => {
                // Update progress
                path.progress += path.speed
                if (path.progress > 1) path.progress = 0

                // Draw the static path
                ctx.beginPath()
                ctx.strokeStyle = `rgba(${path.color.r}, ${path.color.g}, ${path.color.b}, 0.3)`
                ctx.lineWidth = 1.5
                ctx.moveTo(path.points[0].x, path.points[0].y)
                for (let i = 1; i < path.points.length; i++) {
                    ctx.lineTo(path.points[i].x, path.points[i].y)
                }
                ctx.stroke()

                // Draw nodes at joints
                path.points.forEach((point, idx) => {
                    const nodeAlpha = 0.4 + Math.sin(timeRef.current * 3 + idx) * 0.2
                    ctx.beginPath()
                    ctx.fillStyle = `rgba(${path.color.r}, ${path.color.g}, ${path.color.b}, ${nodeAlpha})`
                    ctx.arc(point.x, point.y, 2, 0, Math.PI * 2)
                    ctx.fill()
                })

                // Draw animated pulse traveling along the path
                const totalLength = path.points.length - 1
                const currentSegment = Math.floor(path.progress * totalLength)
                const segmentProgress = (path.progress * totalLength) % 1

                if (currentSegment < path.points.length - 1) {
                    const startPoint = path.points[currentSegment]
                    const endPoint = path.points[currentSegment + 1]
                    const pulseX = startPoint.x + (endPoint.x - startPoint.x) * segmentProgress
                    const pulseY = startPoint.y + (endPoint.y - startPoint.y) * segmentProgress

                    // Draw pulse glow
                    const pulseGradient = ctx.createRadialGradient(pulseX, pulseY, 0, pulseX, pulseY, 8)
                    pulseGradient.addColorStop(0, `rgba(${path.color.r}, ${path.color.g}, ${path.color.b}, 1)`)
                    pulseGradient.addColorStop(0.5, `rgba(${path.color.r}, ${path.color.g}, ${path.color.b}, 0.5)`)
                    pulseGradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
                    ctx.fillStyle = pulseGradient
                    ctx.fillRect(pulseX - 8, pulseY - 8, 16, 16)
                }
            })

            // Draw the central orb with gradient
            const orbGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbRadius)
            const breathe = 1 + Math.sin(timeRef.current * 1.5) * 0.1
            orbGradient.addColorStop(0, 'rgba(200, 255, 255, 0.9)')
            orbGradient.addColorStop(0.3, 'rgba(16, 185, 129, 0.8)')
            orbGradient.addColorStop(0.7, 'rgba(59, 130, 246, 0.6)')
            orbGradient.addColorStop(1, 'rgba(59, 130, 246, 0)')

            ctx.beginPath()
            ctx.fillStyle = orbGradient
            ctx.arc(cx, cy, orbRadius * breathe, 0, Math.PI * 2)
            ctx.fill()

            // Draw inner orb core
            const coreGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbRadius * 0.5)
            coreGradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)')
            coreGradient.addColorStop(0.5, 'rgba(200, 255, 240, 0.7)')
            coreGradient.addColorStop(1, 'rgba(16, 185, 129, 0.3)')

            ctx.beginPath()
            ctx.fillStyle = coreGradient
            ctx.arc(cx, cy, orbRadius * 0.5 * breathe, 0, Math.PI * 2)
            ctx.fill()

            // Draw energy lines within the orb
            energyLinesRef.current.forEach(line => {
                // Update alpha
                line.alpha += line.fadeDirection * 0.02
                if (line.alpha > 1 || line.alpha < 0) {
                    line.fadeDirection *= -1
                    // Regenerate line position occasionally
                    if (Math.random() > 0.7) {
                        line.x1 = cx + (Math.random() - 0.5) * orbRadius * 1.5
                        line.y1 = cy + (Math.random() - 0.5) * orbRadius * 1.5
                        line.x2 = cx + (Math.random() - 0.5) * orbRadius * 1.5
                        line.y2 = cy + (Math.random() - 0.5) * orbRadius * 1.5
                    }
                }

                ctx.beginPath()
                ctx.strokeStyle = `rgba(200, 255, 255, ${line.alpha * 0.6})`
                ctx.lineWidth = 1
                ctx.moveTo(line.x1, line.y1)
                ctx.lineTo(line.x2, line.y2)
                ctx.stroke()
            })



            animationRef.current = requestAnimationFrame(animate)
        }

        animate()

        return () => {
            cancelAnimationFrame(animationRef.current)
        }
    }, [size, initializeEffects])

    return (
        <canvas
            ref={canvasRef}
            className={className}
            style={{
                width: size,
                height: size,
            }}
        />
    )
}
