/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/index.html'],
  theme: {
    extend: {
      colors: {
        plexus: {
          void: '#050505',
          base: '#0a0a0a',
          raised: '#111111',
          subtle: '#171717',
          code: '#1c1c1c',
        },
      },
    },
  },
  plugins: [],
};
