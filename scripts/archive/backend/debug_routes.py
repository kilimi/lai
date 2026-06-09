#!/usr/bin/env python3
"""
Debug script to check FastAPI app routes
"""

from app.main import app

print("FastAPI App Routes Debug")
print("=" * 50)

print(f"Total routes: {len(app.routes)}")
print()

for i, route in enumerate(app.routes):
    print(f"Route {i+1}:")
    print(f"  Type: {type(route).__name__}")
    if hasattr(route, 'methods'):
        print(f"  Methods: {route.methods}")
    if hasattr(route, 'path'):
        print(f"  Path: {route.path}")
    if hasattr(route, 'name'):
        print(f"  Name: {route.name}")
    print()

# Try to import routers directly
print("Testing router imports:")
try:
    from app.routers import projects
    print(f"✓ Projects router has {len(projects.router.routes)} routes")
    for route in projects.router.routes:
        if hasattr(route, 'methods') and hasattr(route, 'path'):
            print(f"  - {route.methods} {route.path}")
except Exception as e:
    print(f"✗ Projects router error: {e}")

try:
    from app.routers import datasets
    print(f"✓ Datasets router has {len(datasets.router.routes)} routes")
except Exception as e:
    print(f"✗ Datasets router error: {e}")

try:
    from app.routers import tasks
    print(f"✓ Tasks router has {len(tasks.router.routes)} routes")
except Exception as e:
    print(f"✗ Tasks router error: {e}")

try:
    from app.routers import augmentations
    print(f"✓ Augmentations router has {len(augmentations.router.routes)} routes")
except Exception as e:
    print(f"✗ Augmentations router error: {e}")
