// ============================================================================
// p5.js Setup
// ============================================================================

let showMoveCount;
let showMenu = false;
let currentMenuTab = "daily"; // "daily", "alltime", "achievements", "shapes"
let menuScrollY = 0;
let menuDragStartY = null;
let menuDragStartScrollY = null;
let cachedShapeMatches = null; // Cache for shape matching results
let currentAppVersion = null; // Track current app version
let newVersionAvailable = false; // Flag if new version detected
let canvas; // Canvas reference for event listeners

function setup() {
    canvas = createCanvas(w * S, h * S + S);
    canvas.mousePressed(onClick);
    
    // Add touch event listeners for mobile support
    canvas.elt.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.elt.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.elt.addEventListener('touchend', handleTouchEnd, { passive: false });
    
    textAlign(CENTER, CENTER);
    strokeWeight(2);
    
    // Initialize Firebase authentication
    initializeAuth();

    // Load daily splits data
    loadDailySplits();
    
    // Initialize achievement system
    initializeAchievements();
    
    // Restore last opened menu tab
    let savedMenuTab = getItem("currentMenuTab");
    if (savedMenuTab !== null && ["daily", "alltime", "achievements", "shapes"].includes(savedMenuTab)) {
        currentMenuTab = savedMenuTab;
    }

    // Restore saved game or start new game
    let autoSaveSeed = getItem("autoSaveSeed");
    if (autoSaveSeed !== null) {
        let moves = getItem("autoSaveMoves") || "";
        grid = new NumberGrid(w, h, autoSaveSeed, moves.split(""));
    } else {
        newGame();
    }

    showMoveCount = getItem("showMoveCount")
    if (showMoveCount === null) {
        showMoveCount = false
    }
    
    // Start version checking
    initializeVersionCheck();
}

// Set background color
document.body.style.backgroundColor = bgLight;

// ============================================================================
// p5.js Draw Loop
// ============================================================================

function draw() {
    clear();
    grid.draw();
    
    let over = grid.gameOver && grid.settled;
    
    // Draw score bar background
    noStroke();
    fill(over ? "black" : bgLight);
    rect(1, 1, w * S - 2, S - 1);
    
    // Draw score
    fill(over ? "white" : "black");
    if (grid.displayScore < grid.score) {
        grid.displayScore++;
    }

    if (showMoveCount) {
        textSize(30)
        text(grid.moves.length, width / 2, 36)
        textSize(16)
        text("moves", width/2, 56)
    } else {
        textSize(36)
        text(grid.displayScore, width / 2, 42);
    }

    
    // Draw reset button
    stroke(over ? "white" : "black");
    strokeWeight(2);
    let resetX = width - S / 2;
    let resetY = 42;
    line(resetX - 10, resetY, resetX + 10, resetY);
    line(resetX, resetY - 10, resetX, resetY + 10);
    noStroke();
    fill(over ? "white" : "black");

    // Draw score split difference if available
    // if (grid.scoreSplitDiff !== null) {
    //     let sign;
    //     let textColor;
    //     if (grid.scoreSplitDiff < 0) {
    //         sign = "";
    //         textColor = "red";
    //     } else if (grid.scoreSplitDiff === 0) {
    //         sign = "=";
    //         textColor = "gray";
    //     } else {
    //         sign = "+";
    //         textColor = "blue";
    //     }
    //     fill(textColor);
    //     textSize(16);
    //     text("(" + sign + grid.scoreSplitDiff + ")", width / 2, S - 14);
    // }
    
    textSize(32);
    // Draw menu toggle button (hamburger icon)
    stroke(over ? "white" : "black");
    strokeWeight(2);
    strokeCap(PROJECT)
    let iconX = S / 2;
    let iconY = 42;
    line(iconX - 10, iconY - 8, iconX + 10, iconY - 8);
    line(iconX - 10, iconY, iconX + 10, iconY);
    line(iconX - 10, iconY + 8, iconX + 10, iconY + 8);
    noStroke();

    // Draw unified menu panel if toggled on
    if (showMenu) {
        drawMenuPanel();
    }

    // Stop loop when settled and score display is caught up
    if (grid.settled && grid.displayScore == grid.score) {
        noLoop();
    }
    
    // text(frameCount, 20, 20)
}

// ============================================================================
// UI Rendering Functions
// ============================================================================

function drawMenuPanel() {
    // Semi-transparent background
    fill(0, 0, 0, 220);
    stroke(0);
    let panelX = 15;
    let panelY = 95;
    let panelWidth = width - 30;
    let panelHeight = height - 110;
    rect(panelX, panelY, panelWidth, panelHeight);
    noStroke();

    // Draw tabs
    let tabY = 110;
    let tabHeight = 35;
    let tabWidth = panelWidth / 4;
    
    // Tab icons and backgrounds
    let tabs = [
        { id: "daily", icon: "📅", title: "Today's Top 10" },
        { id: "alltime", icon: "🌍", title: "All-Time Top 10" },
        { id: "achievements", icon: "⭐", title: "Achievements" },
        { id: "shapes", icon: "🔷", title: "Shape Tasks" }
    ];
    
    for (let i = 0; i < tabs.length; i++) {
        let tab = tabs[i];
        let tabX = panelX + i * tabWidth;
        
        // Tab background
        if (currentMenuTab === tab.id) {
            fill(60);
        } else {
            fill(30);
        }
        rect(tabX, tabY, tabWidth, tabHeight);
        
        // Tab icon
        if (currentMenuTab === tab.id) {
            fill(255, 215, 0);
        } else {
            fill(180);
        }
        textSize(20);
        textAlign(CENTER, CENTER);
        text(tab.icon, tabX + tabWidth / 2, tabY + tabHeight / 2);
    }
    
    // Draw title for current tab
    fill(255);
    textSize(18);
    textAlign(CENTER, CENTER);
    let currentTab = tabs.find(t => t.id === currentMenuTab);
    text(currentTab.title, width / 2, tabY + tabHeight + 18);
    
    // Content area
    let contentStartY = tabY + tabHeight + 35;
    let contentHeight = panelHeight - (contentStartY - panelY);
    
    if (currentMenuTab === "daily" || currentMenuTab === "alltime") {
        drawLeaderboardContent(panelX, contentStartY, panelWidth, contentHeight);
    } else {
        drawAchievementContent(panelX, contentStartY, panelWidth, contentHeight);
    }
}

function drawLeaderboardContent(panelX, contentStartY, panelWidth, contentHeight) {
    let isAllTime = (currentMenuTab === "alltime");
    let topScores = isAllTime ? topScoresAllTime : topScoresDaily;

    if (topScores.length === 0 && isLoadingScores) {
        textSize(18);
        fill(200);
        textAlign(CENTER, CENTER);
        text("Fetching scores...", width / 2, contentStartY + contentHeight / 2);
    } else if (topScores.length === 0) {
        textSize(18);
        fill(200);
        textAlign(CENTER, CENTER);
        text(isAllTime ? "No scores yet." : "No scores yet today.", width / 2, contentStartY + contentHeight / 2);
    } else {
        textSize(16);
        textAlign(LEFT, CENTER);
        let y = contentStartY + 10;
        for (let i = 0; i < topScores.length; i++) {
            let scoreData = topScores[i];
            let displayText = `${i + 1}. ${scoreData.score}`;

            if (scoreData.displayName) {
                displayText += ` (${scoreData.displayName})`;
            }

            if (scoreData.userId === currentUser?.uid) {
                fill(255, 255, 0);
            } else {
                fill(255);
            }

            text(displayText, panelX + 20, y);
            y += 25;
        }
    }
    
    // Edit name button
    fill(180);
    textSize(16);
    textAlign(RIGHT, CENTER);
    text("✏️ Edit Name", width - 35, contentStartY + contentHeight - 20);
    
    textAlign(CENTER, CENTER);
}

function drawAchievementContent(panelX, contentStartY, panelWidth, contentHeight) {
    // Filter achievements by current tab
    let filteredAchievements = ACHIEVEMENTS.filter(achievement => {
        if (currentMenuTab === "shapes") {
            return achievement.type === "shapes";
        } else {
            return achievement.type !== "shapes";
        }
    });
    
    // Calculate total content height
    let totalHeight = 10;
    for (let achievement of filteredAchievements) {
        if (currentMenuTab === "shapes") {
            // Shapes tab: title + shapes
            let itemHeight = 25; // title
            let numShapes = achievement.shapes.length;
            let numRows = Math.ceil(numShapes / 6);
            itemHeight += 25 + (numRows * 52) + 15; // shapes area with new spacing
            totalHeight += itemHeight;
        } else {
            // Achievements tab: just description
            totalHeight += 30; // description line
        }
    }
    
    // Clamp scroll position
    let maxScroll = Math.max(0, totalHeight - contentHeight);
    menuScrollY = Math.max(0, Math.min(menuScrollY, maxScroll));
    
    // Clip to content area
    push();
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.rect(panelX, contentStartY, panelWidth, contentHeight);
    drawingContext.clip();
    
    // Achievement list with scroll offset
    textAlign(LEFT, CENTER);
    let y = contentStartY + 10 - menuScrollY;
    
    for (let achievement of filteredAchievements) {
        let data = achievementData[achievement.id];
        
        // Skip if completely out of view
        if (y > contentStartY + contentHeight + 100 || y < contentStartY - 100) {
            let itemHeight;
            if (currentMenuTab === "shapes") {
                itemHeight = 25;
                let numShapes = achievement.shapes.length;
                let numRows = Math.ceil(numShapes / 6);
                itemHeight += 25 + (numRows * 52) + 15;
            } else {
                itemHeight = 30;
            }
            y += itemHeight;
            continue;
        }
        
        if (currentMenuTab === "shapes") {
            // For shapes tab: show only description and shapes
            textSize(16);
            if (data.unlocked) {
                fill(255, 215, 0);
                text("✓ " + achievement.description, panelX + 20, y);
            } else {
                fill(200);
                text("○ " + achievement.description, panelX + 20, y);
            }
            
            y += 25;
            
            // Draw shape requirements centered
            let shapeY = y + 15;
            let spacing = 52; // Increased from 35 to accommodate larger shapes
            
            // Use cached shape matching results
            let shapeMatched = cachedShapeMatches?.[achievement.id] || new Array(achievement.shapes.length).fill(false);
            
            let numShapes = achievement.shapes.length;
            let numRows = Math.ceil(numShapes / 6);
            
            for (let i = 0; i < numShapes; i++) {
                let shape = achievement.shapes[i];
                let row = Math.floor(i / 6);
                let col = i % 6;
                let shapesInThisRow = (row === numRows - 1) ? (numShapes % 6 || 6) : 6;
                let rowWidth = shapesInThisRow * spacing;
                let startX = width / 2 - rowWidth / 2 + spacing / 2;
                
                let fillColor = shapeMatched[i] ? 255 : 100;
                drawShape(shape, startX + col * spacing, shapeY + row * spacing, 9, fillColor);
            }
            
            // Calculate height based on number of rows
            y += 25 + (numRows * 52) + 15;
        } else {
            // For achievements tab: show only checkmark and description
            textSize(16);
            if (data.unlocked) {
                fill(255, 215, 0);
                text("✓ " + achievement.description, panelX + 20, y);
            } else {
                fill(200);
                text("○ " + achievement.description, panelX + 20, y);
            }
            
            y += 30;
        }
    }
    
    drawingContext.restore();
    pop();
    
    // Draw scroll indicator if needed
    if (maxScroll > 0) {
        fill(100);
        let scrollBarHeight = (contentHeight / totalHeight) * contentHeight;
        let scrollBarY = contentStartY + (menuScrollY / maxScroll) * (contentHeight - scrollBarHeight);
        rect(panelX + panelWidth - 8, scrollBarY, 4, scrollBarHeight, 2);
    }

    textAlign(CENTER, CENTER);
}

function calculateShapeMatches() {
    // Calculate shape matching results for all shape achievements
    cachedShapeMatches = {};
    
    let shapeAchievements = ACHIEVEMENTS.filter(a => a.type === "shapes");
    
    for (let achievement of shapeAchievements) {
        let remainingCreatedShapes = grid.polyominoList ? [...grid.polyominoList] : [];
        let shapeMatched = new Array(achievement.shapes.length).fill(false);
        
        for (let i = 0; i < achievement.shapes.length; i++) {
            let requiredShape = achievement.shapes[i];
            
            let matchIndex = remainingCreatedShapes.findIndex(createdShape => 
                shapesMatch(createdShape, requiredShape)
            );
            
            if (matchIndex !== -1) {
                shapeMatched[i] = true;
                remainingCreatedShapes.splice(matchIndex, 1);
            }
        }
        
        cachedShapeMatches[achievement.id] = shapeMatched;
    }
}

// ============================================================================
// Event Handlers
// ============================================================================

function onClick() {
    if (mouseY < 80) {
        if (mouseX > width - 80) {
            // Reset button (top right)
            if (grid.gameOver || grid.moves.length < 10 || confirm("Start a new game?")) {
                newGame();
                showMenu = false;
                cachedShapeMatches = null; // Invalidate cache on new game
                loop();
            }
        } else if (mouseX < 80) {
            // Menu toggle button (top left)
            showMenu = !showMenu;
            
            // Fetch scores when showing leaderboard tabs
            if (showMenu && (currentMenuTab === "daily" || currentMenuTab === "alltime")) {
                fetchTopScores(currentMenuTab === "alltime").then(() => {
                    loop();
                });
            }
            
            // Calculate shape matches when opening menu on shapes tab
            if (showMenu && currentMenuTab === "shapes") {
                calculateShapeMatches();
            }
            
            loop();
        } else {
            showMoveCount = !showMoveCount;
            storeItem("showMoveCount", showMoveCount);
        }
    } else {
        if (showMenu) {
            // Check if clicking on tabs
            let panelWidth = width - 30;
            let tabWidth = panelWidth / 4;
            let tabY = 110;
            let tabHeight = 35;
            
            if (mouseY >= tabY && mouseY <= tabY + tabHeight) {
                let tabs = ["daily", "alltime", "achievements", "shapes"];
                for (let i = 0; i < tabs.length; i++) {
                    let tabX = 15 + i * tabWidth;
                    if (mouseX >= tabX && mouseX < tabX + tabWidth) {
                        if (currentMenuTab !== tabs[i]) {
                            currentMenuTab = tabs[i];
                            storeItem("currentMenuTab", currentMenuTab);
                            menuScrollY = 0;
                            
                            // Fetch scores when switching to leaderboard tab
                            if (tabs[i] === "daily" || tabs[i] === "alltime") {
                                fetchTopScores(tabs[i] === "alltime").then(() => {
                                    loop();
                                });
                            }
                            
                            // Calculate shape matches when switching to shapes tab
                            if (tabs[i] === "shapes") {
                                calculateShapeMatches();
                            }
                            
                            loop();
                        }
                        return;
                    }
                }
            }
            
            // Check if clicking edit name button on leaderboard
            if ((currentMenuTab === "daily" || currentMenuTab === "alltime")) {
                let contentStartY = 110 + 35 + 35; // tabY + tabHeight + title
                let contentHeight = (height - 110) - (contentStartY - 95);
                let editButtonY = contentStartY + contentHeight - 20;
                
                if (mouseY >= editButtonY - 10 && mouseY <= editButtonY + 10 && 
                    mouseX >= width - 120) {
                    promptForDisplayName();
                    return;
                }
            }
            
            // Handle drag scrolling for achievement tabs
            if (currentMenuTab === "achievements" || currentMenuTab === "shapes") {
                if (mouseY >= 95 && mouseY <= height - 15) {
                    menuDragStartY = mouseY;
                    menuDragStartScrollY = menuScrollY;
                    return;
                }
            }
            
            // Click elsewhere closes menu
            showMenu = false;
        } else {
            grid.click(mouseX, mouseY);
        }
    }
    redraw();
}

function mouseWheel(event) {
    // Handle scrolling in achievement tabs
    if (showMenu && (currentMenuTab === "achievements" || currentMenuTab === "shapes")) {
        menuScrollY += event.delta;
        redraw();
        return false; // Prevent default scrolling
    }
}

function mouseDragged() {
    // Handle drag scrolling in achievement tabs
    if (showMenu && (currentMenuTab === "achievements" || currentMenuTab === "shapes") && menuDragStartY !== null) {
        let deltaY = menuDragStartY - mouseY;
        menuScrollY = menuDragStartScrollY + deltaY;
        redraw();
        return false;
    }
}

function touchMoved() {
    // Handle touch scrolling in achievement tabs (for p5.js touch events)
    if (showMenu && (currentMenuTab === "achievements" || currentMenuTab === "shapes") && menuDragStartY !== null) {
        // Use touches array if available, otherwise fall back to mouseY
        let currentY = touches.length > 0 ? touches[0].y : mouseY;
        let deltaY = menuDragStartY - currentY;
        menuScrollY = menuDragStartScrollY + deltaY;
        redraw();
        return false;
    }
}

function mouseReleased() {
    // End drag scrolling
    if (menuDragStartY !== null) {
        let dragDistance = Math.abs(mouseY - menuDragStartY);
        menuDragStartY = null;
        menuDragStartScrollY = null;
        
        // If it was just a click (not a drag), close the menu
        if (showMenu && dragDistance < 5 && mouseY >= 95 && mouseY <= height - 15) {
            showMenu = false;
            redraw();
        }
    }
}

function keyPressed() {
    if (!debug) return
    // on keypresses 1-5, replace the box the cursor is hovering over (for debugging purposes)
    if (key >= '1' && key <= '5') {
        let [i, j] = grid.getCoordinates(mouseX, mouseY);
        if (i >= 0 && i < grid.w && j >= 0 && j < grid.h) {
            let box = grid[i][j];
            box.n = parseInt(key);
            box.shape = null;
            box.showShape = false;
            redraw();
        }
    }

    if (key == "u") {
        // undo
    }
}

// ============================================================================
// Touch Event Handlers (for mobile devices)
// ============================================================================

function handleTouchStart(event) {
    if (!showMenu) return;
    
    let touch = event.touches[0];
    let rect = canvas.elt.getBoundingClientRect();
    let touchY = touch.clientY - rect.top;
    
    // Only handle scrolling for achievement/shapes tabs in the scrollable area
    if ((currentMenuTab === "achievements" || currentMenuTab === "shapes") && 
        touchY >= 95 && touchY <= height - 15) {
        menuDragStartY = touchY;
        menuDragStartScrollY = menuScrollY;
        // Don't prevent default yet - only prevent if user actually drags
    }
}

function handleTouchMove(event) {
    if (!showMenu) return;
    if (currentMenuTab !== "achievements" && currentMenuTab !== "shapes") return;
    if (menuDragStartY === null) return;
    
    let touch = event.touches[0];
    let rect = canvas.elt.getBoundingClientRect();
    let touchY = touch.clientY - rect.top;
    
    let deltaY = menuDragStartY - touchY;
    
    // Only scroll and prevent default if moved more than 5 pixels
    if (Math.abs(deltaY) > 5) {
        menuScrollY = menuDragStartScrollY + deltaY;
        redraw();
        event.preventDefault(); // Prevent scrolling the page
    }
}

function handleTouchEnd(event) {
    // Only handle if we started tracking a potential scroll
    if (menuDragStartY !== null) {
        let wasDrag = false;
        
        if (event.changedTouches.length > 0) {
            let touch = event.changedTouches[0];
            let rect = canvas.elt.getBoundingClientRect();
            let touchY = touch.clientY - rect.top;
            let dragDistance = Math.abs(touchY - menuDragStartY);
            wasDrag = dragDistance > 5;
            
            // If it was a drag, prevent the click event from firing
            if (wasDrag) {
                event.preventDefault();
            }
            // If it was just a tap, let onClick handle it (don't close menu here)
        }
        
        menuDragStartY = null;
        menuDragStartScrollY = null;
    }
}

// ============================================================================
// Version Checking
// ============================================================================

function initializeVersionCheck() {
    // Get initial version from current page
    let metaTag = document.querySelector('meta[name="app-version"]');
    if (metaTag) {
        currentAppVersion = metaTag.content;
        console.log('App version:', currentAppVersion);
    }
    
    // Check for updates every 15 minutes
    setInterval(checkForNewVersion, 15 * 60 * 1000);
}

function checkForNewVersion() {
    // Fetch the current index.html to check version
    fetch(window.location.href, {
        cache: 'no-cache',
        headers: {
            'Cache-Control': 'no-cache'
        }
    })
    .then(response => response.text())
    .then(html => {
        // Parse the HTML to find the version meta tag
        let match = html.match(/<meta name="app-version" content="([^"]+)"/);
        if (match && match[1]) {
            let newVersion = match[1];
            if (currentAppVersion && newVersion !== currentAppVersion) {
                console.log('New version detected:', newVersion, '(current:', currentAppVersion + ')');
                // Silently set flag - will reload on next new game
                newVersionAvailable = true;
            }
        }
    })
    .catch(error => {
        console.log('Version check failed:', error);
    });
}