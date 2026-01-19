import os
from typing import List, Tuple

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from PIL import Image

import folder_paths


def pil_to_comfy_tensor(img: "Image.Image"):
    """
    ComfyUI IMAGE convention is float32 in [0,1], shape (1, H, W, 3)
    """
    import numpy as np
    import torch
    from PIL import Image

    if not isinstance(img, Image.Image):
        raise TypeError(f"Expected PIL.Image.Image, got {type(img)}")
    img = img.convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    t = torch.from_numpy(arr)  # (H, W, 3)
    return t.unsqueeze(0)      # (1, H, W, 3)


def resize_pil(img: "Image.Image", size_wh: Tuple[int, int], mode: str):
    from PIL import Image

    resampling = getattr(Image, "Resampling", Image)
    resample = {
        "nearest": resampling.NEAREST,
        "bilinear": resampling.BILINEAR,
        "bicubic": resampling.BICUBIC,
        "lanczos": resampling.LANCZOS,
    }.get(mode, resampling.LANCZOS)
    return img.resize(size_wh, resample=resample)


class MultiImageDragDropLoader:
    """
    Receives a list of uploaded image names from the custom JS widget.
    Outputs:
      - IMAGE batch (optionally resized so it can be concatenated)
      - IMAGE list (each image as its own (1,H,W,3) tensor)
      - STRING list of names
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # This is a CUSTOM WIDGET provided by the JS extension.
                "images": ("MULTI_IMAGE_UPLOAD",),

                # If True, we resize everything to match the first image (so we can output a proper batch).
                "resize_to_first": ("BOOLEAN", {"default": True}),

                "resize_mode": (["nearest", "bilinear", "bicubic", "lanczos"], {"default": "lanczos"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "STRING")
    RETURN_NAMES = ("image_batch", "image_list", "image_names")

    # We want:
    # - image_batch: normal single IMAGE tensor (batched via dim0)
    # - image_list: list of IMAGE tensors
    # - image_names: list of strings
    OUTPUT_IS_LIST = (False, True, True)

    FUNCTION = "load"
    CATEGORY = "image/loaders"

    def load(self, images, resize_to_first=True, resize_mode="lanczos"):
        """
        `images` comes from the widget. We accept either:
          - a Python list of strings
          - a JSON-ish string (in case something serializes oddly)
        """
        import torch
        from PIL import Image

        if images is None:
            raise ValueError("No images provided.")

        if isinstance(images, str):
            # If the widget serialized as a JSON array string, try to parse.
            # (We avoid importing json unless needed.)
            s = images.strip()
            if s.startswith("[") and s.endswith("]"):
                import json
                images = json.loads(s)
            else:
                # Single filename as a string
                images = [images]

        if not isinstance(images, list) or not all(isinstance(x, str) for x in images):
            raise TypeError(f"`images` must be a list[str] (or JSON string). Got: {type(images)} {images}")

        # Load each image from annotated path (e.g. "[input]" handling).
        pil_images: List[Image.Image] = []
        for name in images:
            img_path = folder_paths.get_annotated_filepath(name)
            if not os.path.exists(img_path):
                # Fallback: assume it's in input dir if user passed plain filename
                img_path2 = os.path.join(folder_paths.get_input_directory(), name)
                if os.path.exists(img_path2):
                    img_path = img_path2
                else:
                    raise FileNotFoundError(f"Image not found: {name} (looked for {img_path})")

            pil_images.append(Image.open(img_path))

        # Build image_list (no resizing required).
        image_list = [pil_to_comfy_tensor(img) for img in pil_images]

        # Build image_batch (may require resize).
        if len(pil_images) == 1:
            image_batch = image_list[0]  # already (1,H,W,3)
        else:
            if resize_to_first:
                w0, h0 = pil_images[0].size
                resized = [resize_pil(img, (w0, h0), resize_mode) for img in pil_images]
                batch_tensors = [pil_to_comfy_tensor(img) for img in resized]
                image_batch = torch.cat(batch_tensors, dim=0)  # (N,H,W,3)
            else:
                # Only valid if all shapes match.
                shapes = [(t.shape[1], t.shape[2]) for t in image_list]  # (H,W)
                if len(set(shapes)) != 1:
                    raise ValueError(
                        "Images have different sizes; enable resize_to_first=True "
                        "or use the image_list output."
                    )
                image_batch = torch.cat(image_list, dim=0)

        return (image_batch, image_list, images)


NODE_CLASS_MAPPINGS = {
    "MultiImageDragDropLoader": MultiImageDragDropLoader
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiImageDragDropLoader": "Load Image (Batch Upload)"
}
