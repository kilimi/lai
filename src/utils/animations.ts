import { useEffect, useState } from 'react';

export const fadeIn = {
  hidden: { opacity: 0, y: 10 },
  visible: { 
    opacity: 1, 
    y: 0,
    transition: {
      duration: 0.4,
      ease: [0.22, 1, 0.36, 1]
    }
  },
  exit: { 
    opacity: 0, 
    y: 10,
    transition: {
      duration: 0.3,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

export const scaleIn = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { 
    opacity: 1, 
    scale: 1,
    transition: {
      duration: 0.4,
      ease: [0.22, 1, 0.36, 1]
    }
  },
  exit: { 
    opacity: 0, 
    scale: 0.95,
    transition: {
      duration: 0.3,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

export const slideIn = {
  hidden: { opacity: 0, x: -10 },
  visible: { 
    opacity: 1, 
    x: 0,
    transition: {
      duration: 0.4,
      ease: [0.22, 1, 0.36, 1]
    }
  },
  exit: { 
    opacity: 0, 
    x: -10,
    transition: {
      duration: 0.3,
      ease: [0.22, 1, 0.36, 1]
    }
  }
};

export const staggeredChildren = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2
    }
  }
};

export const blurIn = {
  hidden: { opacity: 0, filter: 'blur(10px)' },
  visible: { 
    opacity: 1, 
    filter: 'blur(0px)',
    transition: {
      duration: 0.5
    }
  }
};

export function useImageLoad(src?: string) {
  const [isLoaded, setIsLoaded] = useState(false);
  
  useEffect(() => {
    // Reset loaded state when src changes
    setIsLoaded(false);
    
    if (!src) {
      return;
    }
    
    const img = new Image();
    img.src = src;
    
    const handleLoad = () => {
      setIsLoaded(true);
    };
    
    const handleError = () => {
      setIsLoaded(false);
    };
    
    img.addEventListener('load', handleLoad);
    img.addEventListener('error', handleError);
    
    // If image is already cached, trigger load immediately
    if (img.complete) {
      setIsLoaded(true);
    }
    
    return () => {
      img.removeEventListener('load', handleLoad);
      img.removeEventListener('error', handleError);
    };
  }, [src]);
  
  const getImageFadeProps = () => ({
    initial: { opacity: 0 },
    animate: isLoaded ? { opacity: 1 } : { opacity: 0 },
    transition: { duration: 0.2 }
  });

  return {
    isLoaded,
    getImageFadeProps
  };
}
