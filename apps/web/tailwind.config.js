/** @type {import('tailwindcss').Config} */
// Colours come from CSS variables (src/index.css) so light and dark themes
// share one set of names. Use these tokens, not raw palette colours.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        surface: token('surface'),
        'surface-2': token('surface-2'),
        border: token('border'),
        'border-strong': token('border-strong'),
        fg: token('fg'),
        muted: token('fg-muted'),
        subtle: token('fg-subtle'),
        accent: token('accent'),
        'accent-fg': token('accent-fg'),
        'accent-soft': token('accent-soft'),
        ok: token('ok'),
        warn: token('warn'),
        high: token('high'),
        danger: token('danger'),
        info: token('info'),
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        DEFAULT: '0.375rem',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        shimmer: 'shimmer 1.4s infinite',
      },
    },
  },
  plugins: [],
};
