---
description: New Project Setup - Guided discovery of project vision, design, and tech stack
---

# New Project Setup Workflow

This workflow guides the creation of a new project by asking upfront questions to understand the user's vision before writing any code. It generates a complete `conductor/` folder with product guides, design guidelines, tech stack documentation, and an initial plan.

## Prerequisites
- MCP server `local-nexus` must be available for scaffolding
- User should have a general idea of what they want to build

---

## Phase 1: Project Discovery

### Step 1.1: Initial Questions
Ask the user the following questions (adapt based on their responses):

**Core Concept:**
> What is the core idea for your project? Describe it in a sentence or two.

**Target Users:**
> Who is the primary target user? (Select all that apply)
> A) Solo Developer / Indie Hacker
> B) Business / Enterprise
> C) General Consumers
> D) Technical/Power Users
> E) [Type your own answer]

**Primary Goals:**
> What are the primary goals of this project? (Select all that apply)
> A) Solve a specific problem
> B) Generate revenue / SaaS
> C) Portfolio / Learning project
> D) Internal tool
> E) [Type your own answer]

---

## Phase 2: Design & Aesthetic

### Step 2.1: Tone of Voice
> What tone of voice should the UI and system messages use?
> A) Professional & Technical: Precise, concise, jargon-heavy
> B) Friendly & Encouraging: Warm, helpful, reassuring
> C) Futuristic & Cyberpunk: Immersive, edgy, thematic
> D) Minimal & Clean: Simple, unobtrusive, functional
> E) [Type your own answer]

### Step 2.2: Visual Aesthetic
> What visual aesthetic best fits your project?
> A) Clean & Minimalist: Lots of whitespace, simple typography (e.g., Vercel, Stripe)
> B) High-Density Dashboard: Data-rich, grid layouts, monospace fonts (e.g., Bloomberg, Grafana)
> C) Cyberpunk / Neon: Dark backgrounds, glowing accents, futuristic UI elements
> D) Playful & Colorful: Vibrant colors, rounded shapes, friendly illustrations
> E) Corporate / Professional: Conservative colors, traditional layouts
> F) [Type your own answer]

### Step 2.3: AI Interaction Style (if applicable)
> If your project includes AI features, how should the AI interact with users?
> A) Servant / Assistant: Subservient, polite ("Here is the result you asked for")
> B) Collaborator / Peer: Equal, consultative ("I think we should try X. What do you think?")
> C) System AI / OS Interface: Robotic, efficient ("Task acknowledged. Initiating sequence.")
> D) Not applicable - no AI features

---

## Phase 3: Technical Foundation

### Step 3.1: Project Type
> What type of project is this?
> A) Web Application (full-stack)
> B) Static Website / Landing Page
> C) CLI Tool
> D) Desktop Application
> E) Mobile App
> F) API / Backend Service
> G) Game
> H) [Type your own answer]

### Step 3.2: Tech Stack Preferences
Based on project type, suggest appropriate tech stacks and ask:
> Do you have any specific technology preferences? (frameworks, languages, databases)
> A) Use recommended defaults for my project type
> B) I have specific preferences: [describe]

**Recommended defaults by type:**
- **Web App:** Next.js + TypeScript + Tailwind CSS + Supabase
- **Static Site:** HTML + CSS + JavaScript (or Astro)
- **CLI Tool:** Node.js or Python
- **API/Backend:** Node.js/Express or Python/FastAPI
- **Game:** HTML5 Canvas + JavaScript

### Step 3.3: Key Features
> What are the essential features for v1? (List 3-5 core features)

---

## Phase 4: Workflow Preferences

### Step 4.1: Code Coverage
> What test code coverage percentage do you want to target?
> A) 80% (Standard)
> B) 90% (High)
> C) [Custom percentage]

### Step 4.2: Commit Frequency
> How often should changes be committed?
> A) After each task (Recommended)
> B) After each phase (batch)

### Step 4.3: Documentation Style
> How should task summaries be recorded?
> A) Git Notes (Recommended - keeps commit history clean)
> B) Commit Message body

---

## Phase 5: Project Generation

### Step 5.1: Create Project Structure
Based on the answers, generate:

1. **Use MCP scaffold** (if new project):
   ```
   mcp_local-nexus_scaffold_new_vibe(name="ProjectName", type="web-app|game|tool")
   ```

2. **Create conductor folder structure:**
   ```
   conductor/
   ├── product.md            # Product guide from Phase 1
   ├── product-guidelines.md # Design guidelines from Phase 2
   ├── tech-stack.md         # Tech stack from Phase 3
   ├── workflow.md           # Development workflow from Phase 4
   ├── tracks.md             # Track index
   ├── setup_state.json      # Setup progress tracking
   ├── code_styleguides/     # Language-specific style guides
   └── tracks/               # Individual track plans
   ```

### Step 5.2: Generate Documents
Create each document based on user responses:

**product.md template:**
```markdown
# Product Guide: [Project Name]

## 1. Initial Concept
[User's description]

## 2. Target Audience
[From Step 1.1]

## 3. Core Value Proposition
[Synthesized from answers]

## 4. Key Features
[From Step 3.3]

## 5. Design Philosophy
[From Phase 2 answers]
```

**product-guidelines.md template:**
```markdown
# Product Guidelines: [Project Name]

## 1. Brand Identity & Voice
[From Step 2.1]

## 2. Visual Design System
[From Step 2.2]

## 3. User Experience (UX) Principles
[Synthesized from aesthetic + interaction style]
```

### Step 5.3: Initialize Git & Commit
```bash
git init (if needed)
git add conductor/
git commit -m "conductor(setup): Initialize project with conductor files"
```

---

## Phase 6: First Track

### Step 6.1: Suggest Initial Track
Based on the project type and features, suggest an initial development track:
> I suggest the following as your first track: [suggestion]
> Does this sound like a good starting point?
> A) Yes
> B) No, I'd prefer: [alternative]

### Step 6.2: Generate Track Files
Create track folder and files:
```
conductor/tracks/[track_name]/
├── metadata.json  # Track metadata
├── spec.md        # Detailed specification
└── plan.md        # Task breakdown
```

---

## Completion
Inform the user:
> ✅ Project setup complete! Here's what was created:
> - `conductor/product.md` - Your product vision
> - `conductor/product-guidelines.md` - Design system
> - `conductor/tech-stack.md` - Technology choices
> - `conductor/workflow.md` - Development process
> - First track: [track name]
>
> You can now begin development or refine any of these documents.
