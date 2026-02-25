# Carbon-Aware Compute Advisor

> Route compute workloads to cleaner grid zones using live carbon-intensity data, policy thresholds, and human approval when needed.

**Live app →** [carbon-aware-advisor.vercel.app](https://carbon-aware-advisor.vercel.app)

---

### What This Project Does

- Pulls live grid intensity data from [Electricity Maps](https://www.electricitymaps.com/) for Nordic zones.
- Evaluates whether to run locally, route to a cleaner zone, or require manager approval.
- Keeps an auditable trail: policy result, timeline, and CSV export.

### Why It Matters

Teams can reduce Scope 2 emissions from compute jobs without losing governance controls.

### How It Works

1. User enters workload energy (kWh), threshold, and primary zone.
2. Backend fetches primary and candidate zone intensities.
3. Policy decides: `run_now_local` · `route_to_clean_region` · `require_manager_decision`
4. If approval is needed, the workflow pauses until manager action, then resumes and finalizes audit output.

### Stack

- **Frontend:** Next.js 14 · TypeScript · Tailwind · Auth.js (Google / GitHub sign-in)
- **Backend:** FastAPI · LangGraph · Python
- **Data:** Electricity Maps API · PostgreSQL (prod) · SQLite (local fallback)
- **Deploy:** Vercel (frontend) · Azure App Service + PostgreSQL (backend)

### Quick Local Run

```bash
# backend
cd carbon_advisor
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app.main:app --reload --port 8000

# frontend (new terminal)
cd carbon_advisor/frontend
npm install && npm run dev
```

Open `http://localhost:3000`.

### Demo Scenarios

- **Grid Clean** → local execution completes directly
- **Route Available** → approval, then routed execution with savings
- **Needs Approval** → postpone or override path

Demo scenarios use synthetic intensity profiles to provide predictable policy paths when live conditions do not trigger every branch.

### Notes

- Accounting shown is location-based.
- Point-in-time intensity is used for estimates; real emissions vary with job duration.
- Carbon intensity data sourced from [Electricity Maps](https://www.electricitymaps.com/).
