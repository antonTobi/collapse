// ============================================================================
// Achievement System
// ============================================================================

// Achievement definitions
const ACHIEVEMENTS = [

    {
        id: "single_move_51",
        description: "Gain exactly 51 points with one move",
        type: "score"
    },
    {
        id: "shape_on_move_6",
        description: "Create a shape tile on the 6th move",
        type: "special"
    },
    {
        id: "score_1000_no_shapes",
        description: "Score 1000+ points without any shape tiles",
        type: "special"
    },
    {
        id: "single_move_100",
        description: "Gain exactly 100 points with one move",
        type: "score"
    },
    {
        id: "score_5000",
        description: "Score 5000+ points",
        type: "score"
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

function unlockAchievement(achievementId) {
    if (!achievementData[achievementId].unlocked) {
        achievementData[achievementId].unlocked = true;
        achievementData[achievementId].unlockedDate = Date.now();
        saveAchievements();
        
        let achievement = ACHIEVEMENTS.find(a => a.id === achievementId);
        console.log(`Achievement Unlocked: ${achievement.description}`);
        
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
            break;
        case "move_made":
            checkScoreAchievements(data);
            checkSpecialAchievements();
            break;
        case "shape_created":
            checkShapeAchievements();
            checkSpecialAchievements();
            break;
    }
}

function checkScoreAchievements(data) {
    // Check score-based achievements
    if (data.score >= 10000) {
        unlockAchievement("score_10000");
    }
    
    if (data.scoreGain == 100) {
        unlockAchievement("single_move_100");
    }

    if (data.scoreGain == 51) {
        unlockAchievement("single_move_51");
    }
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
    
    // Shape on 6th move
    if (grid.moves.length === 6 && grid.polyominoList.length > 0) {
        unlockAchievement("shape_on_move_6");
    }
    
    // Score 1000+ without any shapes
    if (grid.score >= 1000 && grid.polyominoList.length === 0) {
        unlockAchievement("score_1000_no_shapes");
    }
}
