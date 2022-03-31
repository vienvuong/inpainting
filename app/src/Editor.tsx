import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  useWindowSize,
  useLocalStorage,
  useKey,
  useKeyPressEvent,
} from 'react-use'
import { v4 as uuidv4 } from 'uuid'
import { Stage, Layer, Line, Image, Circle, useStrictMode } from 'react-konva'
import {
  FaExpand,
  FaUndo,
  FaRedo,
  FaTimes,
  FaEye,
  FaDownload,
  FaPlay,
} from 'react-icons/fa'
import inpaint from './adapters/inpainting'
import Button from './components/Button'
import Slider from './components/Slider'
import SizeSelector from './components/SizeSelector'
import {
  downloadImage,
  euclideanDist,
  HTMLImageElementToDataURL,
  loadImage,
  useImage,
} from './utils'
import {
  MAX_BRUSH_SIZE,
  MIN_BRUSH_SIZE,
  BRUSH_SIZE_LIMIT_XS,
  BRUSH_SIZE_LIMIT_SM,
  BRUSH_SIZE_STEP_XS,
  BRUSH_SIZE_STEP_SM,
  BRUSH_SIZE_STEP_MD,
  PEN_COLOR,
  ERASER_COLOR,
  MIN_DIST_TO_BRUSH_SIZE_RATIO,
  SCALE_BY,
  TOOLBAR_SIZE,
} from './constants'

interface EditorProps {
  file: File
}

interface Mask {
  id: string
  tool: 'pen' | 'eraser'
  points: number[]
  strokeWidth: number
}

interface Render {
  image: HTMLImageElement
  masks: Mask[]
}

interface Position {
  x: number
  y: number
}

interface ImageSize {
  width: number
  height: number
}

export default function Editor(props: EditorProps) {
  useStrictMode(true)
  const { file } = props
  const windowSize = useWindowSize()

  // ['1080', '2000', 'Original']
  const [sizeLimit, setSizeLimit] = useLocalStorage('sizeLimit', '1080')
  const [imageSize, setImageSize] = useState<ImageSize>()
  const [scale, setScale] = useState<number>(1)
  const [minScale, setMinScale] = useState<number>()

  const [isCtrlPressed, setIsCtrlPressed] = useState<boolean>(false)
  const [isDrawing, setIsDrawing] = useState(false)
  const [isInpaintingLoading, setIsInpaintingLoading] = useState(false)

  const [original, isOriginalLoaded] = useImage(file)
  const [showOriginal, setShowOriginal] = useState(false)
  const [showSeparator, setShowSeparator] = useState(false)

  const [mousePos, setMousePos] = useState<Position>({ x: 0, y: 0 })
  const [brushSize, setBrushSize] = useState(40)
  const [showBrush, setShowBrush] = useState(false)

  const [renders, setRenders] = useState<Render[]>([])
  const [renderIdx, setRenderIdx] = useState(0)
  const [maskIdx, setMaskIdx] = useState(-1)

  const stageRef = useRef<any>()
  const maskLayerRef = useRef<any>()

  const initRender = (options?: Partial<Render>) => {
    const defaults = {
      image: new (window as any).Image(),
      masks: [],
    }

    return {
      ...defaults,
      ...options,
    }
  }

  const hadDrawSomething = () => {
    const { masks } = getRender()
    return masks.length !== 0 && masks[0].points.length !== 0
  }

  const hadRunInpainting = () => {
    return renders.length > 1
  }

  const hadUndo = () => {
    const { masks } = getRender()
    return maskIdx < masks.length - 1 || renderIdx < renders.length - 1
  }

  const stopDrawing = () => {
    setIsDrawing(false)
    const render = getRender()
    render.masks.pop()
    setMaskIdx(maskIdx - 1)
    setRenders(renders)
  }

  const resetZoom = useCallback(() => {
    if (!minScale || !imageSize || !windowSize || !stageRef.current) {
      return
    }
    const { width, height } = imageSize
    const stage = stageRef.current
    const offsetX = (windowSize.width - width * minScale) / 2
    const offsetY = (windowSize.height - height * minScale) / 2
    stage?.x(offsetX)
    stage?.y(offsetY)
    setScale(minScale)
  }, [minScale, imageSize, windowSize])

  const getMaskDataURL = useCallback(() => {
    const stage = stageRef.current
    const maskLayer = maskLayerRef.current

    const oldPosition = { x: stage.x(), y: stage.y() }
    stage.x(0)
    stage.y(0)

    const oldSize = stage.size()
    stage.size(imageSize)

    const oldScale = stage.scale()
    stage.scale({
      x: 1,
      y: 1,
    })

    const maskDataURL = maskLayer.toDataURL()

    stage.x(oldPosition.x)
    stage.y(oldPosition.y)
    stage.size(oldSize)
    stage.scale(oldScale)

    return maskDataURL
  }, [imageSize])

  const getBrushSizeDelta = (isIncreasing: boolean) => {
    let brushSizeDelta = 0
    if (brushSize > BRUSH_SIZE_LIMIT_SM) {
      brushSizeDelta = BRUSH_SIZE_STEP_MD
    }
    if (brushSize > BRUSH_SIZE_LIMIT_XS && brushSize <= BRUSH_SIZE_LIMIT_SM) {
      brushSizeDelta = BRUSH_SIZE_STEP_SM
    }
    if (brushSize <= BRUSH_SIZE_LIMIT_XS) {
      brushSizeDelta = BRUSH_SIZE_STEP_XS
    }
    return isIncreasing ? brushSizeDelta : -brushSizeDelta
  }

  const incrementBrushSize = (_isIncreasing?: boolean) => {
    let isIncreasing = true
    if (_isIncreasing != null && !_isIncreasing) {
      isIncreasing = false
    }
    const brushSizeDelta = getBrushSizeDelta(isIncreasing)
    let newBrushSize = brushSize + brushSizeDelta
    // Clamp to min-max range
    newBrushSize = Math.min(newBrushSize, MAX_BRUSH_SIZE)
    newBrushSize = Math.max(newBrushSize, MIN_BRUSH_SIZE)
    setBrushSize(newBrushSize)
  }

  const decrementBrushSize = () => incrementBrushSize(false)

  const getCursor = useCallback(() => {
    if (isCtrlPressed) {
      return 'grab'
    }
    return 'default'
  }, [isCtrlPressed])

  const getRender = useCallback((): Render => {
    return renders[renderIdx]
  }, [renders, renderIdx])

  const getMasks = useCallback((): Mask[] => {
    const { masks } = getRender()
    return masks.slice(0, maskIdx + 1)
  }, [maskIdx, getRender])

  const runInpainting = useCallback(async () => {
    setIsInpaintingLoading(true)
    try {
      const render = getRender()
      render.masks = render.masks.slice(0, maskIdx + 1)
      setRenders(renders.slice(0, renderIdx + 1))

      const { image } = getRender()
      const imageDataURL = HTMLImageElementToDataURL(image)
      const maskDataURL = getMaskDataURL()
      const res = await inpaint(imageDataURL, maskDataURL, sizeLimit)
      if (!res) {
        throw new Error('Empty response')
      }

      const newImage = new (window as any).Image()
      await loadImage(newImage, res)
      setImageSize({
        width: newImage.naturalWidth,
        height: newImage.naturalHeight,
      })
      const newRender: Render = initRender({ image: newImage })
      setRenders([...renders.slice(0, renderIdx + 1), newRender])
      setRenderIdx(renderIdx + 1)
      setMaskIdx(-1)
    } catch (err: any) {
      // eslint-disable-next-line
      console.error(err.message ? err.message : err.toString())
    }
    setIsInpaintingLoading(false)
  }, [renders, renderIdx, maskIdx, sizeLimit, getMaskDataURL, getRender])

  const handleMouseDown = (e: any) => {
    e.evt.preventDefault()
    if (e.evt.ctrlKey) {
      setIsCtrlPressed(true)
      return
    }

    setIsDrawing(true)
    const point = mousePos
    const isLMB = e.evt.button === 0
    const tool = isLMB ? 'pen' : 'eraser'

    const render = getRender()
    const newMask: Mask = {
      id: uuidv4(),
      tool,
      points: [point.x, point.y, point.x, point.y],
      strokeWidth: brushSize,
    }
    // Append new mask
    render.masks = [...render.masks.slice(0, maskIdx + 1), newMask]
    // Update mask index
    setMaskIdx(maskIdx + 1)
    setRenders(renders.slice(0, renderIdx + 1))
  }

  const handleMouseMove = (e: any) => {
    if (e.evt.ctrlKey) {
      return
    }

    // Use inverted absolute transform to get the relative pointer position
    const pos = maskLayerRef.current.getRelativePointerPosition()
    // Update mouse position
    setMousePos({ x: pos.x, y: pos.y })
    if (!isDrawing) {
      return
    }

    const point = pos
    const { masks } = getRender()
    const mask = masks[maskIdx]
    const lastPoint = {
      x: mask.points[mask.points.length - 2],
      y: mask.points[mask.points.length - 1],
    }
    const distFromLastPoint = euclideanDist(lastPoint, point)
    if (distFromLastPoint > MIN_DIST_TO_BRUSH_SIZE_RATIO * brushSize) {
      // Add point
      mask.points = mask.points.concat([point.x, point.y])
      // Replace last
      masks.splice(maskIdx, 1, mask)
      masks.concat()
      // Update renders
      setRenders(renders)
    }
  }

  const handleMouseUp = () => {
    setIsDrawing(false)
  }

  const handleContextMenu = (e: any) => {
    e.evt.preventDefault()
  }

  const undo = () => {
    if (maskIdx === -1) {
      if (renderIdx) {
        setRenderIdx(renderIdx - 1)
        const render = renders[renderIdx - 1]
        setMaskIdx(render.masks.length - 1)
      }
    } else {
      setMaskIdx(maskIdx - 1)
    }
  }

  const redo = () => {
    let render = getRender()
    if (maskIdx === render.masks.length - 1) {
      if (renderIdx < renders.length - 1) {
        setRenderIdx(renderIdx + 1)
        render = renders[renderIdx + 1]
        if (render.masks.length) {
          setMaskIdx(0)
        } else {
          setMaskIdx(-1)
        }
      }
    } else {
      setMaskIdx(maskIdx + 1)
    }
  }

  const clear = () => {
    const render = getRender()
    render.masks = []
    setMaskIdx(-1)
    setRenders(renders.slice(0, renderIdx))
  }

  const handleScroll = (e: any) => {
    // Changing zoom
    e.evt.preventDefault()
    const scrollingUp = e.evt.deltaY < 0
    if (e.evt.ctrlKey) {
      setIsCtrlPressed(true)
      const newScale = scrollingUp ? scale * SCALE_BY : scale / SCALE_BY
      const stage = e.target.getStage()
      const pointer = stage.getPointerPosition()
      const mousePointTo = {
        x: (pointer.x - stage.x()) / scale,
        y: (pointer.y - stage.y()) / scale,
      }
      const newPos = {
        x: pointer.x - mousePointTo.x * newScale,
        y: pointer.y - mousePointTo.y * newScale,
      }
      setScale(newScale)
      stage.position(newPos)
    }
    // Changing brush size
    else if (scrollingUp) {
      incrementBrushSize()
    } else {
      decrementBrushSize()
    }
  }

  const download = () => {
    if (!renders.length) {
      return
    }
    const name = file.name.replace(/(\.[\w\d_-]+)$/i, '_inpaint$1')
    const currentImg = getRender().image
    downloadImage(currentImg.currentSrc, name)
  }

  const handleSizeLimitChange = (_sizeLimit: string) => {
    setSizeLimit(_sizeLimit)
  }

  const handleEscPressed = () => {
    if (isInpaintingLoading) {
      return
    }
    if (isDrawing) {
      stopDrawing()
    } else {
      resetZoom()
    }
  }

  useEffect(() => {
    if (isOriginalLoaded) {
      setImageSize({
        width: original.naturalWidth,
        height: original.naturalHeight,
      })
      const render: Render = initRender({ image: original })
      setRenders([render])
    }
  }, [isOriginalLoaded, original])

  useEffect(() => {
    if (!windowSize || !imageSize) {
      return
    }
    const { width, height } = imageSize
    const rW = windowSize.width / width
    const rH = (windowSize.height - TOOLBAR_SIZE) / height
    if (rW < 1 || rH < 1) {
      const s = Math.min(rW, rH)
      setMinScale(s)
      setScale(s)
    } else {
      setMinScale(1)
    }
    resetZoom()
  }, [windowSize, imageSize, resetZoom])

  useEffect(() => {
    setShowBrush(!isDrawing && !isCtrlPressed)
  }, [isDrawing, isCtrlPressed])

  useEffect(() => {
    const render = getRender()
    if (render) {
      const { image } = render
      setImageSize({ width: image.width, height: image.height })
    }
  }, [renders, renderIdx, getRender])

  const ctrlPredicate = (e: KeyboardEvent) => {
    return e.key === 'Control' || e.key === 'Meta'
  }
  useKey(
    ctrlPredicate,
    () => setIsCtrlPressed(true),
    {
      event: 'keydown',
    },
    [isCtrlPressed]
  )
  useKey(
    ctrlPredicate,
    () => setIsCtrlPressed(false),
    {
      event: 'keyup',
    },
    [isCtrlPressed]
  )

  const undoPredicate = (e: KeyboardEvent) => {
    const isUndo = e.key === 'z' && e.ctrlKey && !e.shiftKey
    // Also handle tab switch
    if (e.key === 'Tab' || isUndo) {
      e.preventDefault()
    }
    return isUndo
  }
  useKey(undoPredicate, undo)

  const redoPredicate = (e: KeyboardEvent) => {
    const isRedo = e.key === 'Z' && e.ctrlKey && e.shiftKey
    // Also handle tab switch
    if (e.key === 'Tab' || isRedo) {
      e.preventDefault()
    }
    return isRedo
  }
  useKey(redoPredicate, redo)

  useKey(
    'Escape',
    handleEscPressed,
    {
      event: 'keydown',
    },
    [isDrawing, isInpaintingLoading, resetZoom, stopDrawing]
  )

  const displayOriginal = () => {
    setShowSeparator(true)
    setShowOriginal(true)
    localStorage.setItem('renderIdx', String(renderIdx))
    localStorage.setItem('maskIdx', String(maskIdx))
    setRenderIdx(0)
    setMaskIdx(-1)
    setShowBrush(false)
  }

  const displayCurrent = () => {
    setShowOriginal(false)
    setTimeout(() => {
      setShowSeparator(false)
      const oldRenderIdx = Number(localStorage.getItem('renderIdx'))
      const oldMaskIdx = Number(localStorage.getItem('maskIdx'))
      setRenderIdx(oldRenderIdx)
      setMaskIdx(oldMaskIdx)
      setShowBrush(true)
    }, 300)
  }

  useKeyPressEvent(
    'Tab',
    e => {
      e?.preventDefault()
      e?.stopPropagation()
      if (hadRunInpainting()) {
        displayOriginal()
      }
    },
    e => {
      e?.preventDefault()
      e?.stopPropagation()
      if (hadRunInpainting()) {
        displayCurrent()
      }
    }
  )

  if (!isOriginalLoaded || !scale || !minScale || !imageSize) {
    return null
  }

  return (
    <div
      className={
        isInpaintingLoading
          ? 'animate-pulse-fast pointer-events-none transition-opacity'
          : ''
      }
    >
      <Stage
        ref={stageRef}
        width={window.innerWidth}
        height={window.innerHeight}
        onContextMenu={handleContextMenu}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleScroll}
        draggable={isCtrlPressed}
        scaleX={scale}
        scaleY={scale}
        style={{ cursor: getCursor() }}
      >
        <Layer>
          <Image image={getRender().image} />
        </Layer>
        <Layer
          ref={maskLayerRef}
          clipFunc={ctx => {
            ctx.rect(0, 0, imageSize.width, imageSize.height)
          }}
        >
          {getMasks().map((_mask: Mask) => (
            <Line
              key={_mask.id}
              points={_mask.points}
              stroke={_mask.tool === 'pen' ? PEN_COLOR : ERASER_COLOR}
              strokeWidth={_mask.strokeWidth}
              tension={0.5}
              lineJoin="round"
              lineCap="round"
              globalCompositeOperation={
                _mask.tool === 'pen' ? 'source-over' : 'destination-out'
              }
            />
          ))}
        </Layer>
        <Layer>
          {showBrush && (
            <Circle
              x={mousePos.x}
              y={mousePos.y}
              radius={brushSize / 2}
              fill={PEN_COLOR}
            />
          )}
        </Layer>
      </Stage>

      <div className="fixed w-full h-auto bottom-0 flex items-center justify-center">
        <div
          className={[
            'flex flex-row items-center justify-center space-x-6 pl-5 p-2',
            'bg-black backdrop-blur backdrop-filter bg-opacity-10 rounded-xl',
          ].join(' ')}
        >
          <SizeSelector
            value={sizeLimit || '1080'}
            onChange={handleSizeLimitChange}
            originalWidth={original.naturalWidth}
            originalHeight={original.naturalHeight}
          />
          <Slider
            label={
              <span>
                <span className="hidden md:inline">Brush</span>
              </span>
            }
            min={MIN_BRUSH_SIZE}
            max={MAX_BRUSH_SIZE}
            value={brushSize}
            onChange={setBrushSize}
          />
          <div>
            <Button
              className="mr-2"
              icon={<FaExpand className="w-6 h-6" />}
              disabled={scale === minScale}
              onClick={resetZoom}
            />
            <Button
              className="mr-2"
              icon={<FaUndo className="w-6 h-6 p-0.5" />}
              disabled={!hadDrawSomething() && !hadRunInpainting()}
              onClick={undo}
            />
            <Button
              className="mr-2"
              icon={<FaRedo className="w-6 h-6 p-0.5" />}
              disabled={!hadUndo()}
              onClick={redo}
            />
            <Button
              className="mr-2"
              icon={<FaTimes className="w-6 h-6" />}
              disabled={!hadDrawSomething()}
              onClick={clear}
            />
            <Button
              className="mr-2"
              icon={<FaEye className="w-6 h-6" />}
              disabled={!hadRunInpainting()}
              onDown={ev => {
                ev.preventDefault()
                displayOriginal()
              }}
              onUp={() => {
                displayCurrent()
              }}
            />

            <Button
              className="mr-2"
              icon={<FaDownload className="w-6 h-6" />}
              disabled={!hadRunInpainting()}
              onClick={download}
            />

            <Button
              icon={<FaPlay className="w-6 h-6" />}
              disabled={!hadDrawSomething()}
              onClick={runInpainting}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
