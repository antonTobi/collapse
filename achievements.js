// ============================================================================
// Achievement System
// ============================================================================

// Achievement definitions
const ACHIEVEMENTS = [

    // New achievements:
    {
        id: "split_1000_once",
        description: "Make a tile with a value of 1000+ points",
        type: "split"
    },
    {
        id: "split_100_exactly_three",
        description: "Make 3 tiles with a value of exactly 100 points",
        type: "split"
    },
    {
        id: "split_1000_five",
        description: "Make 5 tiles with a value of 1000+ points",
        type: "split"
    },

    // but keep these ones:
    {
        id: "consecutive_3000_x3",
        description: "Score 3000+ points in 3 consecutive games",
        type: "consecutive"
    },
    {
        id: "consecutive_5000_x5",
        description: "Score 5000+ points in 5 consecutive games",
        type: "consecutive"
    },
    {
        id: "consecutive_7000_x7",
        description: "Score 7000+ points in 7 consecutive games",
        type: "consecutive"
    },
    {
        id: "tetrominoes",
        description: "Tetrominoes",
        type: "shapes",
        shapes: [
            [[0, 0], [1, 0], [2, 0], [3, 0]], // I
            [[0, 0], [1, 0], [0, 1], [1, 1]], // O
            [[1, 0], [0, 1], [1, 1], [2, 1]], // T
            [[0, 0], [1, 0], [1, 1], [2, 1]], // S
            [[0, 0], [0, 1], [1, 1], [2, 1]], // L
        ]
    },
    {
        id: "six_crosses",
        description: "Crosses",
        type: "shapes",
        shapes: [
            [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
            [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
            [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
            [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
            [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]],
            [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]]
        ]
    },
    {
        id: "three_rings",
        description: "Rings",
        type: "shapes",
        shapes: [
            [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]],
            [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]],
            [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]]
        ]
    },

    {
        id: "six_straights",
        description: "Straights",
        type: "shapes",
        shapes: [
            [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
            [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
            [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
            [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
            [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
            [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
            // [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
            // [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
            // [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
            // [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
            // [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
        ]
    },
    {
        id: "twelve_dominoes",
        description: "Dominoes",
        type: "shapes",
        shapes: Array(12).fill([[0, 0], [1, 0]])
    },

        {
        id: "pentominoes",
        description: "Pentominoes",
        type: "shapes",
        shapes: [
            [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]], // F
            [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], // I
            [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]], // L
            [[1, 0], [0, 0], [1, 1], [2, 1], [3, 1]], // N
            [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]], // P
            [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]], // T
            [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]], // U
            [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]], // V
            [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]], // W
            [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]], // X
            [[1, 0], [0, 1], [1, 1], [2, 1], [3, 1]], // Y
            [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]]  // Z
        ]
    },


];

// Achievement state
let achievementData = {};
let achievementScrollY = 0;
let achievementDragStartY = null;
let achievementDragStartScrollY = null;

// ============================================================================
// Achievement Management Functions
// ============================================================================

function initializeAchievements() {
    // Load saved achievement data from localStorage
    let savedData = getItem("achievementData");
    
    if (savedData === null) {
        // Initialize fresh achievement data
        achievementData = {};
        ACHIEVEMENTS.forEach(achievement => {
            achievementData[achievement.id] = {
                unlocked: false,
                unlockedDate: null
            };
        });
        saveAchievements();
    } else {
        achievementData = savedData;
        
        // Add any new achievements that might not exist in saved data
        ACHIEVEMENTS.forEach(achievement => {
            if (!achievementData[achievement.id]) {
                achievementData[achievement.id] = {
                    unlocked: false,
                    unlockedDate: null
                };
            }
        });
    }
}

function saveAchievements() {
    storeItem("achievementData", achievementData);
}

function resetAllAchievements() {
    // Reset all achievements to locked state (for debugging)
    achievementData = {};
    ACHIEVEMENTS.forEach(achievement => {
        achievementData[achievement.id] = {
            unlocked: false,
            unlockedDate: null
        };
    });
    saveAchievements();
    console.log("All achievements have been reset");
}

function unlockAchievement(achievementId) {
    if (!achievementData[achievementId].unlocked) {
        achievementData[achievementId].unlocked = true;
        achievementData[achievementId].unlockedDate = Date.now();
        saveAchievements();
        
        let achievement = ACHIEVEMENTS.find(a => a.id === achievementId);
        console.log(`Achievement Unlocked: ${achievement.description}`);
        
        // Set notification for display in top bar
        achievementNotification = "✓ " + achievement.description;
        achievementNotificationTime = Date.now();
        
        return true;
    }
    return false;
}

// ============================================================================
// Shape Matching Functions
// ============================================================================

function normalizeShape(coords) {
    // Normalize coordinates to start at origin
    const minX = Math.min(...coords.map(p => p[0]));
    const minY = Math.min(...coords.map(p => p[1]));
    const normalized = coords.map(p => [p[0] - minX, p[1] - minY]);
    
    // Sort for consistent comparison
    normalized.sort((a, b) => {
        if (a[0] !== b[0]) return a[0] - b[0];
        return a[1] - b[1];
    });
    
    return normalized.map(p => p.join(',')).join(';');
}

function getAllOrientations(coords) {
    // Generate all 8 orientations (4 rotations + 4 reflections)
    const transformations = [
        p => [p[0], p[1]],      // identity
        p => [-p[1], p[0]],     // rotate 90
        p => [-p[0], -p[1]],    // rotate 180
        p => [p[1], -p[0]],     // rotate 270
        p => [-p[0], p[1]],     // flip horizontal
        p => [p[1], p[0]],      // flip diagonal
        p => [p[0], -p[1]],     // flip vertical
        p => [-p[1], -p[0]]     // flip other diagonal
    ];
    
    return transformations.map(transform => 
        normalizeShape(coords.map(transform))
    );
}

function shapesMatch(shape1, shape2) {
    // Check if shape1 matches any orientation of shape2
    const normalized1 = normalizeShape(shape1);
    const orientations2 = getAllOrientations(shape2);
    return orientations2.includes(normalized1);
}

// ============================================================================
// Achievement Check Functions
// ============================================================================

function checkAchievements(eventType, data) {
    // This is the main hub for checking achievements
    
    switch (eventType) {
        case "game_over":
            checkScoreAchievements(data);
            checkShapeAchievements();
            checkSpecialAchievements();
            checkSplitAchievements();
            break;
        case "move_made":
            checkScoreAchievements(data);
            checkSpecialAchievements();
            break;
        case "shape_created":
            checkShapeAchievements();
            checkSpecialAchievements();
            checkSplitAchievements();
            break;
    }
}

// Check for split-based achievements (tile values on 6-tiles)
function checkSplitAchievements() {
    if (!grid || !grid.polyominoList) return;
    // Gather all split values for 6-tiles
    let splits = [];
    for (let i = 0; i < grid.w; i++) {
        for (let j = 0; j < grid.h; j++) {
            let box = grid[i][j];
            if (box.n === 6 && typeof box.split === "number") {
                splits.push(box.split);
            }
        }
    }

    // 1. Make a tile with a value of 1000+ points
    if (splits.some(v => v >= 1000)) {
        unlockAchievement("split_1000_once");
    }

    // 2. Make three tiles with a value of exactly 100 points
    if (splits.filter(v => v === 100).length >= 3) {
        unlockAchievement("split_100_exactly_three");
    }

    // 3. Make five tiles with a value of 1000+ points
    if (splits.filter(v => v >= 1000).length >= 5) {
        unlockAchievement("split_1000_five");
    }
}

function checkScoreAchievements(data) {
    // Check score-based achievements (none for removed achievements)
}

function checkShapeAchievements() {
    // Check all shape-based achievements
    if (!grid || !grid.polyominoList) return;
    
    for (let achievement of ACHIEVEMENTS) {
        if (achievement.type === "shapes" && !achievementData[achievement.id].unlocked) {
            // Count how many of each required shape have been created
            let requiredShapesCopy = [...achievement.shapes];
            
            for (let createdShape of grid.polyominoList) {
                // Find and remove the first matching required shape
                let matchIndex = requiredShapesCopy.findIndex(requiredShape => 
                    shapesMatch(createdShape, requiredShape)
                );
                
                if (matchIndex !== -1) {
                    requiredShapesCopy.splice(matchIndex, 1);
                }
                
                // If all required shapes are matched, unlock achievement
                if (requiredShapesCopy.length === 0) {
                    unlockAchievement(achievement.id);
                    break;
                }
            }
        }
    }
}

function checkSpecialAchievements() {
    // Check special condition achievements
    if (!grid) return;
    
    // No special achievements for removed ones
}
