from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app_core import app


@app.get("/")
async def index():
    return FileResponse("static/index.html")


app.mount("/static", StaticFiles(directory="static"), name="static")
