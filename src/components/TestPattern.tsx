"use client";

import { useEffect, useRef } from "react";
import { encodeGrid, FONT_STACK, type DitherId, type RampId, type OutputTheme } from "@/lib/ascii";

const TAU = Math.PI * 2;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const cellHash = (x: number, y: number) => {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
};

/** Ambient "test card": the drop zone background prints a live character field. */
export default function TestPattern({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let columns = 96;
    let rows = 30;
    let inView = false;
    let reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const initialConnection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    let saveData = Boolean(initialConnection?.saveData || ["slow-2g", "2g"].includes(initialConnection?.effectiveType ?? ""));
    let raf = 0;
    let lastFrame = 0;
    let phase = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      const width = Math.max(canvas.clientWidth, 1);
      const height = Math.max(canvas.clientHeight, 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      columns = Math.max(48, Math.min(140, Math.floor(width / 7)));
      rows = Math.max(12, Math.min(44, Math.floor(height / 15)));
    };

    const draw = (time: number, animate: boolean) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const t = animate ? time * 0.001 : 0;
      const field = new Float32Array(columns * rows);
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const x = (column + 0.5) / columns;
          const y = (row + 0.5) / rows;
          const interference =
            Math.sin(x * TAU * 1.6 + t * 1.3) * Math.cos(y * TAU * 1.1 - t * 0.9) +
            0.45 * Math.sin(x * TAU * 3.1 - t * 1.7 + y * 2.2) +
            0.25 * Math.sin(Math.hypot(x - 0.5, y - 0.5) * 15 - t * 2.1);
          const grain = (cellHash(column, row) - 0.5) * 0.1;
          field[row * columns + column] = clamp01(0.5 + 0.42 * interference + grain + phase);
        }
      }
      const text = encodeGrid(field, columns, rows, "classic" as RampId, "floyd" as DitherId, "dark" as OutputTheme);
      const fontSize = Math.max(6, Math.min((width / columns) * 2, (height / rows) * 1.3));
      context.fillStyle = "#100d0a";
      context.fillRect(0, 0, width, height);
      context.font = `${fontSize.toFixed(1)}px ${FONT_STACK}`;
      context.fillStyle = "rgba(180, 145, 79, .5)";
      context.textBaseline = "top";
      const lines = text.split("\n");
      const lineHeight = fontSize * 1.22;
      for (let i = 0; i < lines.length; i += 1) {
        context.fillText(lines[i], 0, i * lineHeight + 2);
      }
    };

    const canAnimate = () => inView && !document.hidden && !reduced && !saveData;
    const loop = (time: number) => {
      if (!canAnimate()) {
        raf = 0;
        return;
      }
      if (time - lastFrame >= 1000 / 15) {
        phase = Math.sin(time * 0.0006) * 0.03;
        draw(time, true);
        lastFrame = time;
      }
      raf = window.requestAnimationFrame(loop);
    };

    const startOrDraw = () => {
      if (canAnimate()) {
        if (!raf) raf = window.requestAnimationFrame(loop);
      } else {
        draw(0, false);
      }
    };

    const visibilityObserver = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      if (!inView && raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      startOrDraw();
    }, { threshold: 0.1, rootMargin: "60px 0px" });

    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onReducedMotion = () => {
      reduced = reducedQuery.matches;
      startOrDraw();
    };
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string; addEventListener?: (type: string, listener: () => void) => void; removeEventListener?: (type: string, listener: () => void) => void } }).connection;
    const onConnectionChange = () => {
      saveData = Boolean(connection?.saveData || ["slow-2g", "2g"].includes(connection?.effectiveType ?? ""));
      startOrDraw();
    };
    const onVisibilityChange = () => {
      if (document.hidden && raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      startOrDraw();
    };
    const resizeObserver = new ResizeObserver(resize);

    resize();
    draw(0, false);
    visibilityObserver.observe(canvas);
    resizeObserver.observe(canvas);
    document.addEventListener("visibilitychange", onVisibilityChange);
    reducedQuery.addEventListener("change", onReducedMotion);
    connection?.addEventListener?.("change", onConnectionChange);

    return () => {
      visibilityObserver.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reducedQuery.removeEventListener("change", onReducedMotion);
      connection?.removeEventListener?.("change", onConnectionChange);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={canvasRef} className={`test-pattern ${className}`.trim()} aria-hidden="true" />;
}
