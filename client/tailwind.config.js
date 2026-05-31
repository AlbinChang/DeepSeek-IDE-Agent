/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#1e1e1e',
        sidebar: '#252526',
        editor: '#1e1e1e',
        accent: '#58a6ff'
      }
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}