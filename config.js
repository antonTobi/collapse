// Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyAB8uHkJNm_8OtGGCO2f6g_3k2ehFsCzT0",
    authDomain: "collapse-700c3.firebaseapp.com",
    projectId: "collapse-700c3",
    storageBucket: "collapse-700c3.firebasestorage.app",
    messagingSenderId: "342963844921",
    appId: "1:342963844921:web:e2a44b32bfa71099d39ae8",
    measurementId: "G-W2Q5PLTER8"
};

// Game Display Constants
const S = 80;  // Cell size
const X = 0;   // Grid X offset
const Y = 80;  // Grid Y offset

// Physics Constants
const bounceFactor = 0.5;
const gravity = 1;

// Random Number Generator Constants (Linear Congruential Generator)
const m = 4294967296;
const a = 1664525;
const c = 1013904223;

// Alphabet Encoding for Move Recording
const alphabet = "abcdefghijklmnopqrstuvwxyz";
const tebahpla = {};
for (let i = 0; i < 26; i++) {
    tebahpla[alphabet[i]] = i;
}

// Box Color Scheme
const boxColors = {
    1: "#22baac",
    2: "#ffbe53",
    3: "#ee6984",
    4: "#4b6da4",
    5: "#845584",
    6: "#2c2c2c",
};

// Background Color
const bgLight = "#e4e4e4";
const bgDark = "#1d1d1dff";
