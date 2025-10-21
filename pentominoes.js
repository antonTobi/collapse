// Define a single, base shape for each of the 12 pentominoes.
// These have been carefully verified for correctness.
const baseShapes = {
    F: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]],
    I: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
    L: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]],
    N: [[1, 0], [0, 0], [1, 1], [2, 1], [3, 1]],
    P: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]],
    T: [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]],
    U: [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]],
    V: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]],
    W: [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]],
    X: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
    Y: [[1, 0], [0, 1], [1, 1], [2, 1], [3, 1]],
    Z: [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]],
};

/**
 * @fileoverview A utility to identify a pentomino shape from a set of 5 coordinates.
 * This version includes the final corrected base shapes and a visualization function
 * to print the shapes to the console for easy verification.
 */

/**
 * Normalizes a set of coordinates by translating them so the top-most,
 * left-most coordinate is at the origin (0,0), then sorts them to create a
 * consistent, comparable representation.
 * @param {Array<[number, number]>} coords The coordinates to normalize.
 * @returns {string} A unique string signature for the normalized shape.
 */
function normalizeAndStringify(coords) {
    const minX = Math.min(...coords.map(p => p[0]));
    const minY = Math.min(...coords.map(p => p[1]));
    const normalized = coords.map(p => [p[0] - minX, p[1] - minY]);

    // Sort by x-coordinate, then by y-coordinate for a canonical order.
    normalized.sort((a, b) => {
        if (a[0] !== b[0]) return a[0] - b[0];
        return a[1] - b[1];
    });

    return normalized.map(p => p.join(',')).join(';');
}

/**
 * Takes a set of coordinates and prints an ASCII art representation to the console.
 * @param {Array<[number, number]>} coords The coordinates to visualize.
 */
function visualizePentomino(coords) {
    if (!coords || coords.length === 0) return;

    const minX = Math.min(...coords.map(p => p[0]));
    const maxX = Math.max(...coords.map(p => p[0]));
    const minY = Math.min(...coords.map(p => p[1]));
    const maxY = Math.max(...coords.map(p => p[1]));

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;

    // Create an empty grid
    const grid = Array(height).fill(0).map(() => Array(width).fill(' '));

    // Fill the grid with the shape
    for (const [x, y] of coords) {
        grid[y - minY][x - minX] = '■';
    }

    // Print the grid row by row
    console.log(grid.map(row => row.join(' ')).join('\n'));
}


/**
 * Builds and returns a comprehensive lookup table containing all possible normalized
 * string representations for every orientation of each of the 12 pentominoes.
 * @returns {Readonly<Record<string, string>>} A frozen object mapping shape strings to pentomino letters.
 */
function createPentominoLookup() {
    const lookupTable = {};



    // --- Visualize the base shapes for verification ---
    // console.log("--- Base Pentomino Shapes for Verification ---");
    // for (const [letter, coords] of Object.entries(baseShapes)) {
    //     console.log(`\nPentomino: ${letter}`);
    //     visualizePentomino(coords);
    // }
    // console.log("\n----------------------------------------------");


    // Define all 8 orientations (symmetries of a square).
    const transformations = [
        p => [p[0], p[1]], p => [-p[1], p[0]], p => [-p[0], -p[1]], p => [p[1], -p[0]],
        p => [-p[0], p[1]], p => [p[1], p[0]], p => [p[0], -p[1]], p => [-p[1], -p[0]],
    ];

    // For each base shape, generate all 8 orientations, normalize them,
    // and add them to the lookup table.
    for (const [letter, coords] of Object.entries(baseShapes)) {
        for (const transform of transformations) {
            const transformedCoords = coords.map(transform);
            const canonicalString = normalizeAndStringify(transformedCoords);
            lookupTable[canonicalString] = letter;
        }
    }

    return Object.freeze(lookupTable);
}

// --- Main Program State ---
const PENTOMINO_LOOKUP = createPentominoLookup();

/**
 * Identifies which of the 12 pentominoes (FILNPTUVWXYZ) is formed by a given
 * set of 5 coordinates.
 * @param {Array<[number, number]>} coords An array of 5 coordinate pairs.
 * @returns {string|null} The letter for the pentomino, or null if not found.
 */
function identifyPentomino(coords) {
    if (!Array.isArray(coords) || coords.length !== 5) { return null; }
    if (!coords.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number')) { return null; }

    const canonicalString = normalizeAndStringify(coords);
    return PENTOMINO_LOOKUP[canonicalString] || null;
}