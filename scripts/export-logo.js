/**
 * Nexus Logo PNG Exporter
 * 
 * Renders the animated Nexus logo (from nexus-logo.tsx) to a static PNG file
 * using the node-canvas package.
 * 
 * Usage: node scripts/export-logo.js [size] [output-path]
 *   size        - Logo dimensions in pixels (default: 512)
 *   output-path - Output file path (default: nexus-logo.png)
 * 
 * Examples:
 *   node scripts/export-logo.js
 *   node scripts/export-logo.js 1024
 *   node scripts/export-logo.js 1024 ./assets/logo.png
 */

const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const size = parseInt(process.argv[2]) || 512;
const outputPath = process.argv[3] || path.join(__dirname, '..', 'nexus-logo.png');

// How many animation frames to simulate before capturing.
// This lets the animation "settle" into a visually appealing state.
const WARMUP_FRAMES = 60;

// --- Circuit Path Generation ---
function generateCircuitPath(startX, startY, endX, endY, jitterAmount = 0.04, numSegments = 5) {
    // Use a seeded random for reproducibility
    const points = [{ x: startX, y: startY }];
    let currX = startX;
    let currY = startY;

    for (let i = 0; i < numSegments; i++) {
        const ratio = (i + 1) / numSegments;
        const targetX = startX + (endX - startX) * ratio;
        const targetY = startY + (endY - startY) * ratio;

        const jitter = size * jitterAmount;
        let nextX, nextY;

        if (seededRandom() > 0.5) {
            if (seededRandom() > 0.5) {
                nextX = targetX + (seededRandom() - 0.5) * jitter;
                nextY = currY;
            } else {
                nextX = currX;
                nextY = targetY + (seededRandom() - 0.5) * jitter;
            }
        } else {
            nextX = targetX;
            nextY = targetY;
        }

        points.push({ x: nextX, y: nextY });
        currX = nextX;
        currY = nextY;
    }

    points.push({ x: endX, y: endY });
    return points;
}

// Simple seeded PRNG for reproducible output
let seed = 42;
function seededRandom() {
    seed = (seed * 16807 + 0) % 2147483647;
    return (seed - 1) / 2147483646;
}

// --- Initialize Effects ---
function initializeEffects() {
    const cx = size / 2;
    const cy = size / 2;
    const orbRadius = size * 0.12;

    const paths = [];

    // N dimensions
    const nWidth = size * 0.45;
    const nHeight = size * 0.50;
    const nLeft = cx - nWidth / 2;
    const nRight = cx + nWidth / 2;
    const nTop = cy - nHeight / 2;
    const nBottom = cy + nHeight / 2;

    const addStroke = (x1, y1, x2, y2, count, jitter, colorShift) => {
        for (let i = 0; i < count; i++) {
            const offsetX = (seededRandom() - 0.5) * (size * 0.02);
            const offsetY = (seededRandom() - 0.5) * (size * 0.02);

            paths.push({
                points: generateCircuitPath(x1 + offsetX, y1 + offsetY, x2 + offsetX, y2 + offsetY, jitter, 4),
                progress: seededRandom(),
                speed: 0.002 + seededRandom() * 0.003,
                color: { r: 10, g: 200 + seededRandom() * 55, b: 180 + seededRandom() * 75 }
            });
        }
    };

    // LEFT VERTICAL STROKE
    addStroke(nLeft, nBottom, nLeft, nTop, 3, 0.005, 0);
    addStroke(nLeft - size * 0.025, nBottom, nLeft - size * 0.025, nTop, 1, 0.015, 0);
    addStroke(nLeft + size * 0.015, nBottom, nLeft + size * 0.015, nTop, 1, 0.015, 0);

    // DIAGONAL STROKE
    addStroke(nLeft, nTop, nRight, nBottom, 3, 0.005, 20);
    addStroke(nLeft, nTop + size * 0.02, nRight, nBottom + size * 0.02, 1, 0.005, 20);
    addStroke(nLeft + size * 0.02, nTop, nRight - size * 0.02, nBottom, 1, 0.01, 20);

    // RIGHT VERTICAL STROKE
    addStroke(nRight, nTop, nRight, nBottom, 3, 0.005, 40);
    addStroke(nRight + size * 0.025, nTop, nRight + size * 0.025, nBottom, 1, 0.015, 40);
    addStroke(nRight - size * 0.015, nTop, nRight - size * 0.015, nBottom, 1, 0.015, 40);

    // Energy lines
    const energyLines = [];
    for (let i = 0; i < 8; i++) {
        energyLines.push({
            x1: cx + (seededRandom() - 0.5) * orbRadius * 1.5,
            y1: cy + (seededRandom() - 0.5) * orbRadius * 1.5,
            x2: cx + (seededRandom() - 0.5) * orbRadius * 1.5,
            y2: cy + (seededRandom() - 0.5) * orbRadius * 1.5,
            alpha: seededRandom(),
            fadeDirection: seededRandom() > 0.5 ? 1 : -1
        });
    }

    return { paths, energyLines };
}

// --- Render a single frame ---
function renderFrame(ctx, paths, energyLines, time) {
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const orbRadius = size * 0.12;

    // Outer glow
    const glowGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbRadius * 3);
    const glowPulse = 0.3 + Math.sin(time * 2) * 0.1;
    glowGradient.addColorStop(0, `rgba(16, 185, 129, ${glowPulse})`);
    glowGradient.addColorStop(0.5, `rgba(59, 130, 246, ${glowPulse * 0.3})`);
    glowGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glowGradient;
    ctx.fillRect(0, 0, size, size);

    // Circuit paths with animated pulses
    paths.forEach(p => {
        p.progress += p.speed;
        if (p.progress > 1) p.progress = 0;

        // Static path
        ctx.beginPath();
        ctx.strokeStyle = `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, 0.3)`;
        ctx.lineWidth = 1.5;
        ctx.moveTo(p.points[0].x, p.points[0].y);
        for (let i = 1; i < p.points.length; i++) {
            ctx.lineTo(p.points[i].x, p.points[i].y);
        }
        ctx.stroke();

        // Nodes at joints
        p.points.forEach((point, idx) => {
            const nodeAlpha = 0.4 + Math.sin(time * 3 + idx) * 0.2;
            ctx.beginPath();
            ctx.fillStyle = `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, ${nodeAlpha})`;
            ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
            ctx.fill();
        });

        // Animated pulse
        const totalLength = p.points.length - 1;
        const currentSegment = Math.floor(p.progress * totalLength);
        const segmentProgress = (p.progress * totalLength) % 1;

        if (currentSegment < p.points.length - 1) {
            const startPoint = p.points[currentSegment];
            const endPoint = p.points[currentSegment + 1];
            const pulseX = startPoint.x + (endPoint.x - startPoint.x) * segmentProgress;
            const pulseY = startPoint.y + (endPoint.y - startPoint.y) * segmentProgress;

            const pulseGradient = ctx.createRadialGradient(pulseX, pulseY, 0, pulseX, pulseY, 8);
            pulseGradient.addColorStop(0, `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, 1)`);
            pulseGradient.addColorStop(0.5, `rgba(${p.color.r}, ${p.color.g}, ${p.color.b}, 0.5)`);
            pulseGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = pulseGradient;
            ctx.fillRect(pulseX - 8, pulseY - 8, 16, 16);
        }
    });

    // Central orb
    const orbGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbRadius);
    const breathe = 1 + Math.sin(time * 1.5) * 0.1;
    orbGradient.addColorStop(0, 'rgba(200, 255, 255, 0.9)');
    orbGradient.addColorStop(0.3, 'rgba(16, 185, 129, 0.8)');
    orbGradient.addColorStop(0.7, 'rgba(59, 130, 246, 0.6)');
    orbGradient.addColorStop(1, 'rgba(59, 130, 246, 0)');

    ctx.beginPath();
    ctx.fillStyle = orbGradient;
    ctx.arc(cx, cy, orbRadius * breathe, 0, Math.PI * 2);
    ctx.fill();

    // Inner orb core
    const coreGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbRadius * 0.5);
    coreGradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
    coreGradient.addColorStop(0.5, 'rgba(200, 255, 240, 0.7)');
    coreGradient.addColorStop(1, 'rgba(16, 185, 129, 0.3)');

    ctx.beginPath();
    ctx.fillStyle = coreGradient;
    ctx.arc(cx, cy, orbRadius * 0.5 * breathe, 0, Math.PI * 2);
    ctx.fill();

    // Energy lines
    energyLines.forEach(line => {
        line.alpha += line.fadeDirection * 0.02;
        if (line.alpha > 1 || line.alpha < 0) {
            line.fadeDirection *= -1;
        }

        ctx.beginPath();
        ctx.strokeStyle = `rgba(200, 255, 255, ${line.alpha * 0.6})`;
        ctx.lineWidth = 1;
        ctx.moveTo(line.x1, line.y1);
        ctx.lineTo(line.x2, line.y2);
        ctx.stroke();
    });
}

// --- Main ---
function main() {
    console.log(`🎨 Nexus Logo Exporter`);
    console.log(`   Size: ${size}x${size}px`);
    console.log(`   Output: ${outputPath}`);
    console.log(`   Warming up ${WARMUP_FRAMES} frames...`);

    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Initialize
    const { paths, energyLines } = initializeEffects();

    // Simulate animation frames to let it settle into a nice state
    let time = 0;
    for (let frame = 0; frame < WARMUP_FRAMES; frame++) {
        time += 0.016; // ~60fps timestep
        renderFrame(ctx, paths, energyLines, time);
    }

    // Final render
    renderFrame(ctx, paths, energyLines, time);

    // Export to PNG
    const buffer = canvas.toBuffer('image/png');
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, buffer);

    console.log(`\n✅ Logo exported successfully to: ${outputPath}`);
    console.log(`   File size: ${(buffer.length / 1024).toFixed(1)} KB`);
}

main();
