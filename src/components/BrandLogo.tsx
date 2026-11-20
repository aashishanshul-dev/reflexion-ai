import React from 'react';

interface HourglassXMarkProps {
  variant?: 'orange' | 'ink' | 'tile';
  className?: string;
}

/** Hourglass X woven thread emblem from the reflexion.ai light system brand sheet. */
export const HourglassXMark: React.FC<HourglassXMarkProps> = ({
  variant = 'orange',
  className = 'h-7 w-7',
}) => {
  if (variant === 'tile') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
        className={className}
      >
        <rect width="64" height="64" rx="16" fill="#FF5B23" />
        <g stroke="#FFFFFF" strokeWidth="1.4" strokeLinecap="round">
          <path d="M16 14C27 25 27 39 16 50" />
          <path d="M17.5 14C28.3 25 28.3 39 17.5 50" />
          <path d="M19 14C29.6 25 29.6 39 19 50" />
          <path d="M20.5 14C30.9 25 30.9 39 20.5 50" />
          <path d="M22 14C32 25 32 39 22 50" />
          <path d="M48 14C37 25 37 39 48 50" />
          <path d="M46.5 14C35.7 25 35.7 39 46.5 50" />
          <path d="M45 14C34.4 25 34.4 39 45 50" />
          <path d="M43.5 14C33.1 25 33.1 39 43.5 50" />
          <path d="M42 14C32 25 32 39 42 50" />
        </g>
        <rect
          x="30"
          y="30"
          width="4"
          height="4"
          transform="rotate(45 32 32)"
          fill="#FF5B23"
        />
      </svg>
    );
  }

  const stroke = variant === 'ink' ? '#14161F' : '#FF5B23';
  const diamondFill = variant === 'ink' ? '#FFFFFF' : '#F7F6F2';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <g stroke={stroke} strokeWidth="1.5" strokeLinecap="round">
        <path d="M11 8C25 22 25 42 11 56" />
        <path d="M12.6 8C26.4 22 26.4 42 12.6 56" />
        <path d="M14.2 8C27.8 22 27.8 42 14.2 56" />
        <path d="M15.8 8C29.2 22 29.2 42 15.8 56" />
        <path d="M17.4 8C30.6 22 30.6 42 17.4 56" />
        <path d="M19 8C32 22 32 42 19 56" />
        <path d="M53 8C39 22 39 42 53 56" />
        <path d="M51.4 8C37.6 22 37.6 42 51.4 56" />
        <path d="M49.8 8C36.2 22 36.2 42 49.8 56" />
        <path d="M48.2 8C34.8 22 34.8 42 48.2 56" />
        <path d="M46.6 8C33.4 22 33.4 42 46.6 56" />
        <path d="M45 8C32 22 32 42 45 56" />
      </g>
      <rect
        x="29.8"
        y="29.8"
        width="4.4"
        height="4.4"
        transform="rotate(45 32 32)"
        fill={diamondFill}
      />
    </svg>
  );
};

interface ReflexionWordmarkProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Sora Light wordmark integrating the Signal Orange Hourglass X centered on the x-height. */
export const ReflexionWordmark: React.FC<ReflexionWordmarkProps> = ({
  size = 'md',
  className = '',
}) => {
  const sizeClass =
    size === 'lg'
      ? 'text-[28px] leading-none'
      : size === 'sm'
        ? 'text-[19px] leading-none'
        : 'text-[22px] leading-none';

  return (
    <span
      className={`inline-flex items-baseline font-display font-light tracking-[-0.045em] text-ink whitespace-nowrap shrink-0 select-none ${sizeClass} ${className}`}
      aria-label="reflexion.ai"
    >
      <span>refle</span>
      <span className="inline-flex items-center justify-center mx-[0.02em] self-center translate-y-[0.03em]">
        <HourglassXMark variant="orange" className="h-[1.06em] w-[1.06em]" />
      </span>
      <span>ion</span>
      <span className="text-signal font-normal">.ai</span>
    </span>
  );
};

interface BrandEmptyStateProps {
  title: string;
  description: string;
  action?: React.ReactNode;
  compact?: boolean;
}

/** Calm paper/ink empty state using the 1-colour Ink Hourglass X symbol. */
export const BrandEmptyState: React.FC<BrandEmptyStateProps> = ({
  title,
  description,
  action,
  compact = false,
}) => (
  <div
    className={`rounded-2xl border border-dashed border-hairline-strong bg-surface text-center ${
      compact ? 'p-8' : 'p-12'
    }`}
  >
    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-paper border border-hairline">
      <HourglassXMark variant="ink" className="h-7 w-7 opacity-80" />
    </div>
    <h3 className="text-sm font-semibold text-ink font-display">{title}</h3>
    <p className="mx-auto mt-1 max-w-sm text-xs text-slate leading-relaxed">{description}</p>
    {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
  </div>
);
