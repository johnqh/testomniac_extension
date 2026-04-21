/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/**/*.{js,ts,jsx,tsx,html}',
    './node_modules/@sudobility/components/**/*.{js,jsx,ts,tsx}',
    './node_modules/@sudobility/design/**/*.{js,jsx,ts,tsx}',
    './node_modules/@sudobility/building_blocks/**/*.{js,jsx,ts,tsx}',
    './node_modules/@sudobility/auth-components/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
