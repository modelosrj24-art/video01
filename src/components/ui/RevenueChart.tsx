import React, { useState } from 'react';
import { formatBRL } from '../../lib/format';

interface SeriesPoint {
  label: string;
  valueCents: number;
  secondaryValue?: number;
}

export function RevenueChart({
  title,
  subtitle,
  data,
  secondaryLabel = 'Chamadas',
}: {
  title: string;
  subtitle?: string;
  data: SeriesPoint[];
  secondaryLabel?: string;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-[#111115] p-6">
        <div className="text-sm font-semibold text-[#F5F2EB]">{title}</div>
        {subtitle && <div className="text-xs text-zinc-400 mt-1">{subtitle}</div>}
        <div className="h-48 flex items-center justify-center text-xs text-zinc-500">
          Nenhum movimento financeiro registrado neste período.
        </div>
      </div>
    );
  }

  const maxVal = Math.max(100, ...data.map((d) => d.valueCents));
  const width = 640;
  const height = 210;
  const padX = 28;
  const padY = 20;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const points = data.map((d, i) => {
    const x = data.length === 1 ? padX + innerW / 2 : padX + (i / (data.length - 1)) * innerW;
    const y = padY + innerH - (d.valueCents / maxVal) * innerH;
    return { ...d, x, y };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath =
    points.length > 1
      ? `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(padY + innerH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(padY + innerH).toFixed(1)} Z`
      : '';

  const active = hoveredIdx !== null ? points[hoveredIdx] : points[points.length - 1];

  return (
    <div className="rounded-xl border border-white/10 bg-[#111115] p-6">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-[#F5F2EB]">{title}</h3>
          {subtitle && <p className="text-xs text-zinc-400 mt-0.5">{subtitle}</p>}
        </div>
        {active && (
          <div className="text-right">
            <div className="text-base font-semibold font-mono tabular-nums text-[#E5C97B]">
              {formatBRL(active.valueCents)}
            </div>
            <div className="text-xs text-zinc-400 font-mono tabular-nums">
              {active.label}
              {active.secondaryValue !== undefined ? ` · ${active.secondaryValue} ${secondaryLabel}` : ''}
            </div>
          </div>
        )}
      </div>

      <div className="w-full overflow-hidden">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-52 overflow-visible">
          <defs>
            <linearGradient id="aurumChartGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#D4AF37" stopOpacity="0.32" />
              <stop offset="100%" stopColor="#D4AF37" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {[0.25, 0.5, 0.75, 1].map((frac) => {
            const gy = padY + innerH - frac * innerH;
            return (
              <line
                key={frac}
                x1={padX}
                y1={gy}
                x2={width - padX}
                y2={gy}
                stroke="rgba(255,255,255,0.06)"
                strokeDasharray="3 3"
              />
            );
          })}

          {areaPath && <path d={areaPath} fill="url(#aurumChartGrad)" />}
          {points.length > 1 && <path d={linePath} fill="none" stroke="#D4AF37" strokeWidth="2.25" />}

          {points.map((pt, idx) => {
            const isHovered = hoveredIdx === idx;
            return (
              <g key={pt.label + idx}>
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isHovered ? 6 : 3.5}
                  fill={isHovered ? '#F5F2EB' : '#D4AF37'}
                  stroke="#09090B"
                  strokeWidth="1.5"
                />
                <rect
                  x={pt.x - 20}
                  y={0}
                  width={40}
                  height={height}
                  fill="transparent"
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredIdx(idx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                />
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export function ProfileAvatar({
  src,
  name,
  className = 'w-14 h-14',
}: {
  src: string | null | undefined;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  if (!src || failed) {
    return (
      <div
        className={`${className} rounded-xl bg-gradient-to-br from-[#27272A] to-[#141418] border border-white/10 flex items-center justify-center font-display font-semibold text-[#E5C97B] shrink-0`}
      >
        {initials || 'AP'}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${className} rounded-xl object-cover border border-white/10 shrink-0`}
    />
  );
}
