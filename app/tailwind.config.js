module.exports = {
  mode: 'jit',
  theme: {
    extend: {
      animation: {
        'pulse-fast': 'pulse 0.7s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      colors: {
        primary: '#BDFF01',
      },
      keyframes: {
        pulse: {
          '0%, 100%': { opacity: 0.8 },
          '50%': { opacity: 0.7 },
        },
      },
    },
  },
  variants: {},
  plugins: [],
  content: [
    // Filenames to scan for classes
    './src/**/*.html',
    './src/**/*.js',
    './src/**/*.jsx',
    './src/**/*.ts',
    './src/**/*.tsx',
    './public/index.html',
  ],
}
