"""Legacy Gradio entrypoint placeholder.

The active application is the routing-first stack:
- FastAPI backend: backend/app/main.py
- Next.js frontend: frontend/app/page.tsx

The old Gradio prototype was moved to legacy/gradio_app.py to avoid
mixing forecast-era UI code with the current routing-first implementation.
"""


if __name__ == "__main__":
    print("This repository now uses FastAPI + Next.js.")
    print("Legacy Gradio app: python legacy/gradio_app.py")
