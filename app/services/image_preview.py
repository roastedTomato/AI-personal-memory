"""Bounded in-memory previews; original uploads are never modified."""
from functools import lru_cache
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps


@lru_cache(maxsize=24)
def image_preview(path: str, modified_ns: int, size: int, variant: str) -> bytes:
    # Modification time and size invalidate the cache when a source changes.
    limit = 256 if variant == "thumbnail" else 1200
    with Image.open(Path(path)) as source:
        source.draft("RGB", (limit, limit))
        image = ImageOps.exif_transpose(source)
        image.thumbnail((limit, limit), Image.Resampling.LANCZOS)
        if image.mode != "RGB":
            rgba = image.convert("RGBA")
            image = Image.new("RGB", rgba.size, "white")
            image.paste(rgba, mask=rgba.getchannel("A"))
        output = BytesIO()
        image.save(output, format="JPEG", quality=78)
        return output.getvalue()
