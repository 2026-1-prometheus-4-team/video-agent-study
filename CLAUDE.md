# CLAUDE.md

## Project Overview

This project is an AI-powered video editing agent (similar to Claude Code, but for video editing).
The user gives natural language commands, and the agent automatically handles trend research, video planning, and editing.

The project has two tracks running in parallel:
- Personal competition build (solo, due early May)
- Team study + Prometheus club demo day build (team of 4, due early August)

---

## Tech Stack

- LangGraph (Multi-agent: Orchestrator / Research / Planning / Edit Agent)
- FastAPI + WebSocket (streaming)
- Next.js (frontend, Claude Code style UI)
- Whisper / faster-whisper (speech-to-text, timestamp extraction)
- Qdrant (vector DB for semantic scene search)
- Gemini 1.5 Pro (multimodal video frame analysis)
- FFmpeg (actual video editing execution)
- Tavily API (web search for trend research)
- YouTube Data API (trending video analysis)

---

## Project Structure

```
agent.py           - LangGraph core logic (AgentState, Tools, Graph)
server.py          - FastAPI server (REST + WebSocket streaming)
requirements.txt
SETUP.md           - Git branch strategy and local setup guide
CLAUDE.md          - This file
```

---

## AgentState Schema

```python
class AgentState(TypedDict):
    messages: Annotated[list, add_messages]
    video_context: Optional[VideoContext]
    edit_history: list[str]
```

---

## VideoContext Schema

```python
class VideoContext(TypedDict):
    file_path: str
    duration: float
    scenes: list[Scene]        # from PySceneDetect
    transcript: list[Transcript]  # from Whisper
```

```python
class Scene(TypedDict):
    start: float
    end: float
    description: str

class Transcript(TypedDict):
    start: float
    end: float
    text: str
```

---

## Current Tools (Dummy - to be replaced with real implementations)

- search_scene          : semantic scene search (-> Qdrant)
- calculate_timestamp   : timestamp calculation
- get_video_info        : video metadata (-> FFmpeg)

---

## Tools to Implement (Real)

### Edit Agent Tools
- cut_scene             : FFmpeg video cut
- merge_clips           : FFmpeg clip merge
- add_subtitle          : FFmpeg subtitle insertion
- add_bgm               : background music addition (Demucs)

### Research Agent Tools
- web_search            : trend research (Tavily API)
- youtube_trend         : YouTube trending video analysis
- competitor_analysis   : similar channel video structure analysis

### Planning Agent Tools
- generate_concept      : AI video concept generation
- generate_script       : script generation
- generate_shot_list    : shooting guide generation (when no footage exists)

---

## Multi-Agent Structure

```
Orchestrator Agent
    - overall flow control and routing

Research Agent
    - trend analysis
    - web search
    - YouTube trending

Planning Agent
    - concept generation
    - script writing
    - shot list creation

Edit Agent
    - video cutting
    - clip merging
    - subtitle insertion
    - BGM addition
    - semantic scene search via Qdrant
```

---

## Full Pipeline Flow

```
User input: "Make a trending YouTube video"
    -> Research Agent: trend analysis + keyword extraction
    -> Planning Agent: generate 3 concept options
    -> User selects one
    -> Planning Agent: script + shot list
    -> Branch:
        footage exists  -> Edit Agent directly
        no footage      -> show shot list as shooting guide
                        -> user uploads footage
                        -> Edit Agent
    -> Edit Agent: auto editing + preview
    -> User feedback loop
    -> Final output
```

---

## Development Schedule

### Phase 1 (now ~ early May) - Personal competition build
- Week 1 (4/7 ~ 4/13)  : LangGraph multi-agent base + FFmpeg Tool 3 + timestamp-based editing
- Week 2 (4/14 ~ 4/20) : Whisper pipeline + Qdrant RAG + semantic scene search
- Week 3 (4/21 ~ 4/27) : Gemini multimodal + VideoContext completion + Research/Planning Agent
- Week 4 (4/28 ~ 5/5)  : FastAPI + WebSocket + Next.js UI + demo finalization + submit

### Phase 2 (May ~ June) - Team build
- 5/12  : team repo setup + role assignment based on personal project structure
- 5/19  : VideoContext pipeline team version
- 5/26  : FastAPI server + WebSocket completion
- 6/2   : Gemini multimodal fusion team version
- 6/9   : Next.js timeline UI
- 6/16  : frontend-backend integration
- 6/23  : internal demo + feature gap analysis

### Phase 3 (June ~ August) - Polish + Demo Day
- 6/30  : command coverage expansion + error handling
- 7/7   : UX improvement + preview feature
- 7/14  : stabilization + performance optimization
- 7/21  : demo scenario + presentation materials
- 7/28  : rehearsal + final bug fix
- 8/4   : Prometheus Demo Day

---

## Team Study Session Structure

### Team Composition
- Seongmin (leader)   : agent design + LangGraph + Next.js UI
- Backend dev 1       : FastAPI + WebSocket + FFmpeg execution
- Backend dev 2       : pipeline API + Qdrant management
- ML dev              : Whisper + Gemini multimodal fusion

### Weekly Session Format (every Tuesday, 2 hours)
```
30 min  : concept explanation or code review
60 min  : live coding together
30 min  : homework check + assignment for next week
```

### Session Plan

#### Session 1 (4/7) - Agent Structure
- concept : Tool Use, ReAct loop, LangGraph State/Node/Edge
- code    : walk through agent.py line by line
- coding  : each person adds one @tool function live
- homework:
  - backend devs : add one @tool function and wire into graph
  - ML dev       : install faster-whisper, extract subtitle JSON from sample video

#### Session 2 (4/28) - VideoContext Schema + Qdrant
- concept : Qdrant vector DB, semantic search
- review  : homework presentations (5 min each)
- coding  : agree on VideoContext schema, load Whisper output into Qdrant
- homework:
  - backend devs : implement one FastAPI endpoint
  - ML dev       : run Qdrant search query on subtitle data

#### Session 3 (5/5) - Multi-Agent Structure
- concept : Orchestrator pattern, multi-agent coordination
- coding  : LangGraph multi-agent example together
- setup   : team repo creation + role assignment confirmed
- homework:
  - backend devs : implement WebSocket streaming endpoint
  - ML dev       : Gemini API frame analysis test

#### Session 4 (5/12) - Team Project Kickoff
- review  : walk through personal competition project as reference
  (present as "example project I built for study purposes")
- coding  : split into roles and start building from team repo
- output  : each person has their module running locally

#### Session 5 ~ 10 (5/19 ~ 6/23)
- 5/19   : VideoContext pipeline team version
- 5/26   : FastAPI + WebSocket complete
- 6/2    : Gemini multimodal fusion
- 6/9    : Next.js timeline UI base
- 6/16   : frontend-backend connection + integration test
- 6/23   : internal demo + gap analysis

#### Session 11 ~ 15 (6/30 ~ 7/28)
- 6/30   : command coverage + error handling
- 7/7    : UX + preview feature
- 7/14   : stabilization + optimization
- 7/21   : demo scenario + slides
- 7/28   : rehearsal + final bug fix

---

## Coding Rules

- Never rename existing class names or function names (no "enhanced_", "new_", "updated_" prefixes)
- No emojis anywhere in code or documentation
- All tool functions must include try/except error handling
- Use VideoContext as the central state passed between agents
- When adding a new tool, always register in both tools list and tool_map
- Branch naming: feature/name-feature (e.g. feature/minsu-cut-tool)
- Commit format: "feat: description" / "fix: description" / "refactor: description"
- .env file must never be committed
- All PRs require review before merging to main
