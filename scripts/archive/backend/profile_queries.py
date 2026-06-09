"""
Profile database queries for dataset loading
Run this script to see query execution times
"""
import time
import sys
sys.path.insert(0, '.')

from sqlalchemy import create_engine, event, func
from sqlalchemy.orm import Session
from app.database import SessionLocal, engine
from app import models

# Enable query logging with timing
query_times = []

@event.listens_for(engine, "before_cursor_execute")
def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
    conn.info.setdefault('query_start_time', []).append(time.time())

@event.listens_for(engine, "after_cursor_execute")
def after_cursor_execute(conn, cursor, statement, parameters, context, executemany):
    total = time.time() - conn.info['query_start_time'].pop(-1)
    query_times.append({
        'query': statement[:200],  # Truncate long queries
        'time_ms': total * 1000,
        'parameters': str(parameters)[:100] if parameters else None
    })

def profile_dataset_load(dataset_id: int):
    """Profile all queries needed to load a dataset page"""
    global query_times
    query_times = []
    
    db = SessionLocal()
    
    print(f"\n{'='*80}")
    print(f"PROFILING DATASET {dataset_id}")
    print(f"{'='*80}\n")
    
    total_start = time.time()
    
    # 1. Get dataset
    print("1. GET /datasets/{dataset_id}")
    start = time.time()
    
    dataset = db.query(models.Dataset).filter(models.Dataset.id == dataset_id).first()
    if not dataset:
        print(f"   Dataset {dataset_id} not found!")
        return
    
    annotation_count = db.query(func.count(models.Annotation.id)).filter(
        models.Annotation.dataset_id == dataset_id
    ).scalar() or 0
    
    annotation_file_count = db.query(func.count(models.AnnotationFile.id)).filter(
        models.AnnotationFile.dataset_id == dataset_id
    ).scalar() or 0
    
    print(f"   Time: {(time.time() - start)*1000:.2f}ms")
    print(f"   Dataset: {dataset.name}, {dataset.image_count} images, {annotation_count} annotations, {annotation_file_count} annotation files")
    
    # 2. Get images
    print("\n2. GET /datasets/{dataset_id}/images")
    start = time.time()
    
    images = db.query(models.Image).filter(models.Image.dataset_id == dataset_id).all()
    
    print(f"   Time: {(time.time() - start)*1000:.2f}ms")
    print(f"   Found {len(images)} images")
    
    # 3. Get image collections
    print("\n3. GET /datasets/{dataset_id}/image-collections")
    start = time.time()
    
    collections = db.query(models.ImageCollection).filter(
        models.ImageCollection.dataset_id == dataset_id
    ).all()
    
    # This is where the N+1 problem is - loading images for each collection
    collection_images = 0
    for collection in collections:
        collection_images += len(collection.images)  # This triggers lazy loading
    
    print(f"   Time: {(time.time() - start)*1000:.2f}ms")
    print(f"   Found {len(collections)} collections with {collection_images} total images")
    
    # 4. Get annotations (this is the SLOW one)
    print("\n4. GET /datasets/{dataset_id}/annotations")
    start = time.time()
    
    db_annotation_files = db.query(models.AnnotationFile).filter(
        models.AnnotationFile.dataset_id == dataset_id
    ).order_by(models.AnnotationFile.created_at.desc()).all()
    
    annotation_file_details = []
    for db_file in db_annotation_files:
        file_start = time.time()
        
        # This query runs for EACH annotation file - N+1 problem!
        afi_list = db.query(models.AnnotationFileImage).filter(
            models.AnnotationFileImage.annotation_file_id == db_file.id
        ).all()
        
        total_referenced_images = len(afi_list)
        present_count = sum(1 for afi in afi_list if afi.dataset_image_id is not None)
        
        file_time = (time.time() - file_start) * 1000
        annotation_file_details.append({
            'name': db_file.name,
            'annotation_count': db_file.annotation_count,
            'query_time_ms': file_time,
            'afi_count': total_referenced_images
        })
    
    print(f"   Time: {(time.time() - start)*1000:.2f}ms")
    print(f"   Found {len(db_annotation_files)} annotation files")
    for detail in annotation_file_details:
        print(f"      - {detail['name']}: {detail['annotation_count']} annotations, {detail['afi_count']} AFI records, query time: {detail['query_time_ms']:.2f}ms")
    
    total_time = (time.time() - total_start) * 1000
    
    print(f"\n{'='*80}")
    print(f"TOTAL TIME: {total_time:.2f}ms")
    print(f"{'='*80}")
    
    # Print slowest queries
    print(f"\n{'='*80}")
    print("TOP 10 SLOWEST QUERIES:")
    print(f"{'='*80}")
    
    sorted_queries = sorted(query_times, key=lambda x: x['time_ms'], reverse=True)[:10]
    for i, q in enumerate(sorted_queries, 1):
        print(f"\n{i}. {q['time_ms']:.2f}ms")
        print(f"   Query: {q['query']}")
    
    # Summary
    print(f"\n{'='*80}")
    print("SUMMARY:")
    print(f"{'='*80}")
    print(f"Total queries executed: {len(query_times)}")
    print(f"Total query time: {sum(q['time_ms'] for q in query_times):.2f}ms")
    print(f"Average query time: {sum(q['time_ms'] for q in query_times) / len(query_times):.2f}ms")
    
    db.close()

if __name__ == "__main__":
    dataset_id = 34  # Your merged dataset
    if len(sys.argv) > 1:
        dataset_id = int(sys.argv[1])
    
    profile_dataset_load(dataset_id)
