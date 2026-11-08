import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#fff4ec', 100: '#ffe4d0', 200: '#ffc9a3', 300: '#ffa468', 400: '#ff7a2f', 500: '#f45d0a', 600: '#d94a05', 700: '#b03a08', 800: '#8c2f0f', 900: '#73290f' },
        ink: { 900: '#141210', 700: '#3a3632', 500: '#6b655f', 300: '#b5aea6', 100: '#efeae4', 50: '#faf7f3' },
      },
      fontFamily: { sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Inter', 'sans-serif'] },
      boxShadow: { card: '0 1px 2px rgba(20,18,16,.06), 0 8px 24px -12px rgba(20,18,16,.18)' },
    },
  },
  plugins: [],
} satisfies Config;
