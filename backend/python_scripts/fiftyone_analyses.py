
import fiftyone as fo
import fiftyone.utils.coco as fouc
import fiftyone.utils.eval as foue

# --- DELETE ALL EXISTING DATASETS ---
print("Deleting all existing FiftyOne datasets...")
for dataset_name in fo.list_datasets():
    fo.delete_dataset(dataset_name)
    print(f"  Deleted: {dataset_name}")
print("All datasets deleted.\n")

# --- CONFIGURATION ---
dataset_name = "WR_Zhytomyr_26072025"
confidence_thresholds = [0.5]  # Test 4 different confidence levels
iou_thresholds = [0.1]  # Test different IoU thresholds (lower = more lenient matching)
display_results_in_fiftyone = True  # Set to False to skip displaying datasets in FiftyOne App

# Paths to 4 ground truth files in COCO format with corresponding image directories
ground_truth_paths = [
    "C:\\Users\\Lilita\\Downloads\\WR_320_Gly_export.json",
    "C:\\Users\\Lilita\\Downloads\\WR_320_NoGly_export.json",
    "C:\\Users\\Lilita\\Downloads\\WR_560_Gly_export.json",
    "C:\\Users\\Lilita\\Downloads\\WR_560_NoGly_export.json",
]

image_dirs = [
    "E:\\projects\\lai\\backend\\projects\\4\\33\\images",
    "E:\\projects\\lai\\backend\\projects\\4\\34\\images",
    "E:\\projects\\lai\\backend\\projects\\4\\35\\images",
    "E:\\projects\\lai\\backend\\projects\\4\\36\\images",                                         
]

# Paths to 4 prediction files in COCO format
prediction_paths = [
    "C:\\Users\\Lilita\\Downloads\\evaluation_169_all_coco\\WR_320_Gly_coco.json",
    "C:\\Users\\Lilita\\Downloads\\evaluation_169_all_coco\\WR_320_NoGly_coco.json",
    "C:\\Users\\Lilita\\Downloads\\evaluation_169_all_coco\\WR_560_Gly_coco.json",
    "C:\\Users\\Lilita\\Downloads\\evaluation_169_all_coco\\WR_560_NoGly_coco.json",
]
#### OR DATASETS ####
ground_truth_paths_or = [
    "C:\\Users\\Lilita\\Downloads\\OR_320_Gly_export.json",
    "C:\\Users\\Lilita\\Downloads\\OR_320_NoGly_export.json",
    "C:\\Users\\Lilita\\Downloads\\OR_560_Gly_export.json",
    "C:\\Users\\Lilita\\Downloads\\OR_560_NoGly_export.json",
]

image_dirs_or = [
    "E:\\projects\\lai\\backend\\projects\\4\\37\\images",
    "E:\\projects\\lai\\backend\\projects\\4\\38\\images",
    "E:\\projects\\lai\\backend\\projects\\4\\39\\images",
    "E:\\projects\\lai\\backend\\projects\\4\\40\\images",
]

prediction_paths_or = [
    "C:\\Users\\Lilita\\Downloads\\OR_Training\\OR_320_Gly_coco.json",
    "C:\\Users\\Lilita\\Downloads\\OR_Training\\OR_320_NoGly_coco.json",
    "C:\\Users\\Lilita\\Downloads\\OR_Training\\OR_560_Gly_coco.json",
    "C:\\Users\\Lilita\\Downloads\\OR_Training\\OR_560_NoGly_coco.json",
]

#ground_truth_paths = ground_truth_paths_or
#image_dirs = image_dirs_or
#prediction_paths = prediction_paths_or

# --- LOAD DATASETS ---
datasets = []
for i, (gt_path, image_dir) in enumerate(zip(ground_truth_paths, image_dirs), start=1):
    dataset_id = f"{dataset_name}_gt_{i}"
    print(f"Loading ground truth dataset {i} from {gt_path} with images from {image_dir}...")
    dataset = fo.Dataset.from_dir(
        dataset_dir=None,
        dataset_type=fo.types.COCODetectionDataset,
        data_path=image_dir,
        labels_path=gt_path,
        name=dataset_id
    )
    datasets.append(dataset)

# --- ADD PREDICTIONS TO EACH DATASET ---
import json
import os
from fiftyone.core.labels import Detection, Detections

for ds_idx, (dataset, pred_path) in enumerate(zip(datasets, prediction_paths), start=1):
    label_field = "predictions"
    print(f"Adding predictions from {pred_path} to dataset {ds_idx} as '{label_field}'...")
    
    # Load COCO predictions
    with open(pred_path) as f:
        coco_pred_data = json.load(f)
    
    # Handle different JSON structures
    if isinstance(coco_pred_data, dict):
        predictions_list = coco_pred_data.get("annotations", [])
        images_list = coco_pred_data.get("images", [])
        categories_list = coco_pred_data.get("categories", [])
    else:
        predictions_list = coco_pred_data
        images_list = []
        categories_list = []
    
    # Build image_id to filename mapping from predictions
    image_id_to_filename = {}
    for img in images_list:
        image_id_to_filename[img["id"]] = img["file_name"]
    
    # Build category_id to name mapping
    category_id_to_name = {}
    for cat in categories_list:
        category_id_to_name[cat["id"]] = cat["name"]
    
    # Group predictions by filename
    predictions_by_filename = {}
    for pred in predictions_list:
        if isinstance(pred, dict):
            image_id = pred.get("image_id")
            filename = image_id_to_filename.get(image_id, str(image_id))
            if filename not in predictions_by_filename:
                predictions_by_filename[filename] = []
            predictions_by_filename[filename].append(pred)
    
    print(f"  Found {len(predictions_by_filename)} images with predictions")
    
    # Add predictions to samples by filename matching
    matched_count = 0
    for sample in dataset:
        # Get filename from sample filepath
        sample_filename = os.path.basename(sample.filepath)
        
        if sample_filename in predictions_by_filename:
            detections = []
            for pred in predictions_by_filename[sample_filename]:
                # COCO format: [x, y, width, height]
                bbox = pred.get("bbox", [0, 0, 0, 0])
                x, y, w, h = bbox
                # Get label name from category
                category_id = pred.get("category_id", 0)
                label_name = category_id_to_name.get(category_id, str(category_id))
                # Convert to normalized coordinates [top-left-x, top-left-y, width, height]
                detection = Detection(
                    label=label_name,
                    bounding_box=[x / sample.metadata.width, y / sample.metadata.height, 
                                 w / sample.metadata.width, h / sample.metadata.height],
                    confidence=pred.get("score", 1.0)
                )
                detections.append(detection)
            
            sample[label_field] = Detections(detections=detections)
            sample.save()
            matched_count += 1
        else:
            # No predictions for this sample - set empty detections
            sample[label_field] = Detections(detections=[])
            sample.save()
    
    print(f"  Matched {matched_count} samples with predictions")

# --- DISPLAY DATASETS ---
if display_results_in_fiftyone:
    print("\nDisplaying datasets with predictions and ground truth...")
    for ds_idx, dataset in enumerate(datasets, start=1):
        print(f"\nOpening dataset {ds_idx} in FiftyOne App...")
        session = fo.launch_app(dataset)
        input(f"Press Enter to continue after viewing dataset {ds_idx}...")
else:
    print("\nSkipping FiftyOne App display (display_results_in_fiftyone=False)")

print("\nAll datasets viewed. Proceeding to evaluation...")

# --- EVALUATE EACH PREDICTION AGAINST EACH GROUND TRUTH ---
results = {}

# Default label field for COCO datasets is "detections"
gt_field = "detections"
label_field = "predictions"

for ds_idx, dataset in enumerate(datasets, start=1):
    dataset_results = {}
    classes = dataset.default_classes  # COCO classes or your dataset classes
    
    for iou_threshold in iou_thresholds:
        iou_results = {}
        
        for conf_threshold in confidence_thresholds:
            print(f"Evaluating dataset {ds_idx} with IoU={iou_threshold}, confidence={conf_threshold}...")
            
            # Filter predictions by confidence threshold using F() expression
            from fiftyone import ViewField as F
            view = dataset.filter_labels(
                label_field,
                F("confidence") >= conf_threshold
            )
            
            # Create valid eval key (replace dots with underscores)
            iou_str = str(iou_threshold).replace(".", "_")
            conf_str = str(conf_threshold).replace(".", "_")
            eval_key = f"eval_ds{ds_idx}_iou{iou_str}_conf{conf_str}"
            results_obj = view.evaluate_detections(
                label_field,
                gt_field=gt_field,
                eval_key=eval_key,
                method="coco",  # COCO-style evaluation
                iou=iou_threshold,  # Set IoU threshold
                compute_mAP=True
            )

            # Get evaluation results using the results object
            metrics = results_obj.metrics()
            
            # Get per-class report with precision, recall, F1
            try:
                report = results_obj.report()
                class_scores = {}
                for cls_name, cls_metrics in report.items():
                    if cls_name not in ["macro avg", "micro avg", "weighted avg"]:
                        class_scores[cls_name] = {
                            "precision": cls_metrics.get("precision", 0.0),
                            "recall": cls_metrics.get("recall", 0.0),
                            "f1-score": cls_metrics.get("f1-score", 0.0),
                            "support": cls_metrics.get("support", 0)
                        }
                
                # Store overall metrics
                eval_results = {
                    "classes": class_scores,
                    "mAP": metrics.get("mAP", 0.0),
                    "mAP50": metrics.get("mAP50", 0.0),
                    "mAP75": metrics.get("mAP75", 0.0)
                }
            except Exception as e:
                print(f"  Warning: Could not get detailed report: {e}")
                eval_results = {
                    "classes": {},
                    "mAP": metrics.get("mAP", 0.0),
                    "mAP50": metrics.get("mAP50", 0.0),
                    "mAP75": metrics.get("mAP75", 0.0)
                }

            iou_results[f"conf_{conf_threshold}"] = eval_results
        
        dataset_results[f"iou_{iou_threshold}"] = iou_results
    
    results[f"dataset_{ds_idx}"] = dataset_results

# --- PRINT RESULTS ---
print("\n" + "="*80)
print("EVALUATION RESULTS - F1 SCORES PER DATASET, IoU AND CONFIDENCE THRESHOLD")
print("="*80)

for dataset_key, dataset_results in results.items():
    print(f"\n{dataset_key}:")
    print("="*70)
    for iou_key, iou_results in dataset_results.items():
        print(f"\n  {iou_key}:")
        print(f"  {'-'*65}")
        for conf_key, eval_results in iou_results.items():
            print(f"\n    {conf_key}:")
            print(f"      Overall: mAP={eval_results['mAP']:.4f}, mAP50={eval_results['mAP50']:.4f}, mAP75={eval_results['mAP75']:.4f}")
            print(f"      Per-class results:")
            print(f"      {'Class':<20} {'Precision':<12} {'Recall':<12} {'F1-Score':<12} {'Support':<10}")
            print(f"      {'-'*66}")
            for cls_name, cls_metrics in eval_results['classes'].items():
                print(f"      {cls_name:<20} {cls_metrics['precision']:<12.4f} {cls_metrics['recall']:<12.4f} {cls_metrics['f1-score']:<12.4f} {cls_metrics['support']:<10}")

print("\n" + "="*80)
