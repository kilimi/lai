import { useState, useRef, useEffect } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dataset } from "@/types";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Loader2, Image as ImageIcon, UploadCloud, X, Tag, Plus } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";

const datasetSchema = z.object({
  name: z.string().min(2, { message: "Name must be at least 2 characters" }).max(50, { message: "Name cannot exceed 50 characters" }),
  description: z.string().max(500, { message: "Description cannot exceed 500 characters" }).optional(),
  tags: z.array(z.string()).optional(),
});

type DatasetFormValues = z.infer<typeof datasetSchema>;

interface DatasetFormProps {
  initialData?: Partial<Dataset>;
  onSubmit: (data: DatasetFormValues, logoFile?: File) => void;
  loading?: boolean;
  mode?: "create" | "edit";
  projectMode?: boolean;
  projectId?: string;
}

export function DatasetForm({ initialData, onSubmit, loading = false, mode = "create", projectMode = false, projectId }: DatasetFormProps) {
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | undefined>(initialData?.thumbnailUrl);
  const [tags, setTags] = useState<string[]>(initialData?.tags || []);
  const [tagInput, setTagInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  
  const form = useForm<DatasetFormValues>({
    resolver: zodResolver(datasetSchema),
    defaultValues: {
      name: initialData?.name || "",
      description: initialData?.description || "",
      tags: initialData?.tags || [],
    },
  });

  // Update form and preview when initialData changes (for edit mode)
  useEffect(() => {
    if (initialData && mode === "edit") {
      form.reset({
        name: initialData.name || "",
        description: initialData.description || "",
        tags: initialData.tags || [],
      });
      setTags(initialData.tags || []);
      // Only update logoPreview if no new file is selected
      if (!logoFile) {
        setLogoPreview(initialData.thumbnailUrl);
      }
    }
  }, [initialData?.id, initialData?.thumbnailUrl, mode, logoFile, form]);
  
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];

      const fileName = file.name.toLowerCase();
      // Logos are previewed in a browser <img> tag, so we only accept formats
      // browsers can actually decode. TIFF is intentionally excluded — it would
      // upload fine but the preview would stay blank.
      const allowedExt = /\.(png|jpe?g|webp|gif|svg)$/i;
      const allowedMime = /^image\/(png|jpe?g|webp|gif|svg\+xml)$/i;
      const isAllowed = allowedMime.test(file.type) || allowedExt.test(fileName);

      if (!isAllowed) {
        toast({
          title: "Unsupported logo format",
          description: "Use PNG, JPG, WebP, GIF, or SVG. TIFF is not previewable in the browser.",
          variant: "destructive",
        });
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        toast({
          title: "Logo too large",
          description: "Maximum size is 5 MB.",
          variant: "destructive",
        });
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      setLogoFile(file);

      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setLogoPreview(event.target.result as string);
        }
      };
      reader.onerror = () => {
        toast({
          title: "Could not read logo",
          description: "The file could not be loaded for preview.",
          variant: "destructive",
        });
      };
      reader.readAsDataURL(file);
    }
  };
  
  const handleRemoveLogo = () => {
    setLogoFile(null);
    setLogoPreview(undefined);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };
  
  const addTag = () => {
    if (tagInput.trim() && !tags.includes(tagInput.trim())) {
      const newTags = [...tags, tagInput.trim()];
      setTags(newTags);
      form.setValue('tags', newTags);
      setTagInput("");
      if (tagInputRef.current) {
        tagInputRef.current.focus();
      }
    }
  };
  
  const removeTag = (tagToRemove: string) => {
    const newTags = tags.filter(tag => tag !== tagToRemove);
    setTags(newTags);
    form.setValue('tags', newTags);
  };
  
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag();
    }
  };
  
  const handleSubmit = (data: DatasetFormValues) => {
    // Include tags in the form data
    onSubmit({ ...data, tags }, logoFile);
  };
  
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Dataset Name</FormLabel>
              <FormControl>
                <Input placeholder="e.g., Vehicle Detection Dataset" {...field} />
              </FormControl>
              <FormDescription>
                A short, descriptive name for your dataset
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea 
                  placeholder="Describe the purpose and contents of this dataset..." 
                  className="resize-none min-h-[120px]"
                  {...field} 
                />
              </FormControl>
              <FormDescription>
                Optional description to help you remember what this dataset contains
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        
        <div className="space-y-2">
          <FormLabel>Tags</FormLabel>
          <FormDescription>
            Add tags to help organize and search for this dataset
          </FormDescription>
          
          <div className="flex items-center space-x-2">
            <div className="relative flex-1">
              <Tag className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                ref={tagInputRef}
                placeholder="Add tags..."
                className="pl-9"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
            <Button 
              type="button" 
              size="sm"
              variant="outline" 
              onClick={addTag}
              disabled={!tagInput.trim()}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </div>
          
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {tags.map((tag, index) => (
                <div
                  key={index}
                  className="flex items-center bg-secondary text-secondary-foreground px-3 py-1 rounded-full text-sm"
                >
                  <Tag className="h-3 w-3 mr-1.5" />
                  <span>{tag}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-4 w-4 p-0 ml-2 text-secondary-foreground hover:bg-transparent"
                    onClick={() => removeTag(tag)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        
        <div className="space-y-2">
          <FormLabel>Dataset Logo</FormLabel>
          <FormDescription>
            Optional logo for your dataset (max 5MB)
          </FormDescription>
          
          {!logoPreview ? (
            <div 
              onClick={() => fileInputRef.current?.click()}
              className="cursor-pointer rounded-md border-2 border-dashed border-muted-foreground/25 hover:border-muted-foreground/50 transition-all p-8 flex flex-col items-center justify-center text-center"
            >
              <UploadCloud className="h-10 w-10 mb-2 text-muted-foreground" />
              <p className="text-muted-foreground">Click to upload a logo image</p>
              <p className="text-xs text-muted-foreground">SVG, PNG, JPG (max 5MB)</p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
          ) : (
            <div className="relative rounded-md overflow-hidden border border-border h-48 flex items-center justify-center">
              <img 
                src={logoPreview} 
                alt="Logo preview" 
                className="max-w-full max-h-full object-contain"
                loading="lazy"
              />
              <Button 
                variant="destructive" 
                size="icon" 
                onClick={handleRemoveLogo}
                className="absolute top-2 right-2 h-8 w-8"
                type="button"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
        
        <div className="flex justify-end space-x-4 pt-4">
          <Button 
            type="button" 
            variant="outline" 
            onClick={() => window.history.back()}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {mode === "create" ? "Create Dataset" : "Save Changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
