
import json
import argparse

def remove_class_from_coco(input_file, output_file, class_name_to_remove):
    # Load COCO annotations
    with open(input_file, 'r') as f:
        coco_data = json.load(f)

    # Find the category ID for the class to remove
    category_id_to_remove = None
    new_categories = []
    for category in coco_data['categories']:
        if category['name'] == class_name_to_remove:
            category_id_to_remove = category['id']
        else:
            new_categories.append(category)

    if category_id_to_remove is None:
        print(f"Class '{class_name_to_remove}' not found in categories.")
        return

    # Filter out annotations with the category ID
    new_annotations = [
        ann for ann in coco_data['annotations']
        if ann['category_id'] != category_id_to_remove
    ]

    # Remove images that no longer have annotations
    annotated_image_ids = {ann['image_id'] for ann in new_annotations}
    new_images = [
        img for img in coco_data['images']
        if img['id'] in annotated_image_ids
    ]

    # Update COCO data
    coco_data['categories'] = new_categories
    coco_data['annotations'] = new_annotations
    coco_data['images'] = new_images

    # Save updated annotations
    with open(output_file, 'w') as f:
        json.dump(coco_data, f, indent=4)

    print(f"✅ Class '{class_name_to_remove}' and its annotations removed successfully.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Remove a class and its annotations from COCO dataset.")
    parser.add_argument("-i", "--input", required=True, help="Path to input COCO JSON file.")
    parser.add_argument("-o", "--output", required=True, help="Path to output COCO JSON file.")
    parser.add_argument("--class", required=True, help="Class name to remove.")

    args = parser.parse_args()
    remove_class_from_coco(args.input, args.output, args.__dict__['class'])
