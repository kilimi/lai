import { Dataset } from "@/types";

export const getMockDataset = (id: string): Dataset => ({
  id: Number(id),
  name: "Vehicle Detection",
  description: "Urban traffic dataset with annotations for cars, trucks, and pedestrians.",
  tags: ["traffic", "vehicles", "urban"],
  created_at: "2023-06-15T10:30:00Z",
  updated_at: "2023-06-15T10:30:00Z",
  image_count: 0,
  annotation_count: 0,
  annotation_file_count: 0,
  project_id: 1,
  thumbnailUrl: "https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D&auto=format&fit=crop&w=1000&q=80",
});