"""FastAPI application entry point for the DECA Roleplay Trainer backend.

This step (scaffold + Phase 1) only exposes a health check. The Vite dev server
proxies /api/* here, so no CORS middleware is needed in development. CORS is
only added later if the frontend and backend are deployed to separate origins
(e.g. Vercel frontend + Oracle box backend).
"""

from fastapi import FastAPI

app = FastAPI(title="DECA Roleplay Trainer", version="0.1.0")


@app.get("/api/health")
def health() -> dict[str, str]:
    """Liveness check used by the frontend to prove the wire works."""
    return {"status": "ok"}
