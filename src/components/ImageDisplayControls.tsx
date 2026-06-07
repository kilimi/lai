import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
interface ImageDisplayControlsProps {
  imagesPerPage: number;
  onImagesPerPageChange: (value: number) => void;
  imageSize: number;
  onImageSizeChange: (value: number[]) => void;
}

export function ImageDisplayControls({
  imagesPerPage,
  onImagesPerPageChange,
  imageSize,
  onImageSizeChange,
}: ImageDisplayControlsProps) {
  return (
    <div className="flex items-center gap-6 flex-wrap">
      {/* Per page */}
      <div className="flex items-center gap-3">
        <Label htmlFor="imagesPerPage" className="text-xs text-muted-foreground whitespace-nowrap">Per page</Label>
        <Select
          value={imagesPerPage.toString()}
          onValueChange={(value) => onImagesPerPageChange(parseInt(value))}
        >
          <SelectTrigger className="w-20 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="12">12</SelectItem>
            <SelectItem value="20">20</SelectItem>
            <SelectItem value="32">32</SelectItem>
            <SelectItem value="48">48</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Size slider */}
      <div className="flex items-center gap-3 flex-1 min-w-[150px] max-w-[300px]">
        <Label htmlFor="imageSize" className="text-xs text-muted-foreground whitespace-nowrap">Size</Label>
        <Slider
          id="imageSize"
          min={100}
          max={600}
          step={20}
          value={[imageSize]}
          onValueChange={onImageSizeChange}
          className="flex-1"
        />
      </div>
    </div>
  );
}
