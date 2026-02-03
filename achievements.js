// ============================================================================
// Achievement System
// ============================================================================

// Achievement definitions
const ACHIEVEMENTS = [
    {
        id: "first_3_splits_100",
        description: "Have the first 3 splits be multiples of 100",
        type: "split"
    },
    {
        id: "bottom_row_12345",
        description: "Make the bottom row read \"12345\"",
        type: "special"
    },
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
        id: "no_shapes_game",
        description: "Lose a game without collapsing any 5's",
        type: "special"
    },
    {
        id: "no_bottom_row_5000",
        description: "Score 5000+ points without any moves\nin the bottom row",
        type: "special"
    },
    {
        id: "no_middle_column_2000",
        description: "Score 2000+ points without any moves\nin the middle column",
        type: "special"
    },
    {
        id: "score_1000_in_1min",
        description: "Reach 1000 points in 1 minute",
        type: "time"
    },
    {
        id: "score_3000_in_3min",
        description: "Reach 3000 points in 3 minutes",
        type: "time"
    },
    {
        id: "score_5000_in_5min",
        description: "Reach 5000 points in 5 minutes",
        type: "time"
    },
    {
        id: "score_7000_in_7min",
        description: "Reach 7000 points in 7 minutes",
        type: "time"
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

// Check for split-based achievements
function checkSplitAchievements() {
    if (!grid || !grid.scoreSplits) return;
    
    // Check if first 3 splits are multiples of 100
    if (grid.scoreSplits.length >= 3) {
        let firstThreeSplits = [
            grid.scoreSplits[0],
            grid.scoreSplits[1] - grid.scoreSplits[0],
            grid.scoreSplits[2] - grid.scoreSplits[1]
        ];
        if (firstThreeSplits.every(split => split > 0 && split % 100 === 0)) {
            unlockAchievement("first_3_splits_100");
        }
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
    
    // Check for game over without any shape tiles
    if (grid.gameOver && grid.scoreSplits.length === 0) {
        unlockAchievement("no_shapes_game");
    }
    
    // Check if bottom row reads "12345"
    let bottomRow = [];
    for (let i = 0; i < grid.w; i++) {
        bottomRow.push(grid[i][0].n);
    }
    if (bottomRow.join('') === '12345') {
        unlockAchievement("bottom_row_12345");
    }
    
    // Check for 5000 points without using bottom row
    if (grid.gameOver && grid.score >= 5000) {
        let usedBottomRow = [...grid.clickedPositions].some(pos => pos.endsWith(',0'));
        if (!usedBottomRow) {
            unlockAchievement("no_bottom_row_5000");
        }
    }
    
    // Check for 2000 points without using middle column
    if (grid.gameOver && grid.score >= 2000) {
        let usedMiddleColumn = [...grid.clickedPositions].some(pos => pos.startsWith('2,'));
        if (!usedMiddleColumn) {
            unlockAchievement("no_middle_column_2000");
        }
    }
    
    // Check time-based achievements (only during active gameplay)
    // If firstMoveTime is not set (stale client), assume it was 1 hour ago to prevent false awards
    let startTime = grid.firstMoveTime !== null ? grid.firstMoveTime : (Date.now() - 3600000);
    if (!grid.gameOver) {
        let elapsed = Date.now() - startTime;
        
        // 1000 points in 1 minute (60000ms)
        if (grid.score >= 1000 && elapsed <= 60000) {
            unlockAchievement("score_1000_in_1min");
        }
        
        // 3000 points in 3 minutes (180000ms)
        if (grid.score >= 3000 && elapsed <= 180000) {
            unlockAchievement("score_3000_in_3min");
        }
        
        // 5000 points in 5 minutes (300000ms)
        if (grid.score >= 5000 && elapsed <= 300000) {
            unlockAchievement("score_5000_in_5min");
        }
        
        // 7000 points in 7 minutes (420000ms)
        if (grid.score >= 7000 && elapsed <= 420000) {
            unlockAchievement("score_7000_in_7min");
        }
    }
}
