var LC_SLIAC_global = function(
    ROI,
    startDate,
    endDate,
    year,
    landCoverType,
    S1Collection,
    boundingBoxSize,
    referenceAngle,
    acquisitionMode) {


    // set the optional parameters of the function
    boundingBoxSize = boundingBoxSize || 10000; // 10000 for a 20x20 km bouding box
    referenceAngle = referenceAngle || 9999; // 9999 to calculate with the mean angle
    acquisitionMode = acquisitionMode || 'IW';
    S1Collection = S1Collection || ee.ImageCollection('COPERNICUS/S1_GRD')
                                  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
                                  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
                                  .filter(ee.Filter.eq('instrumentMode', acquisitionMode))
                                  .filterBounds(ROI)
                                  .filterDate(startDate, endDate);

    // Setting for CGLC - if you require 2014, the CGLC from 2015 will be used, 
    // because CGCL is available only from 2015 till 2019. If years older from 2014 
    // are requested, the code will end with error - Sentinel-1 Collection is not 
    // available. 
    if (year == 14) {
      print("For 2014, the CGLC is used from 2015.");
      year = 15;
    }
    else if (year < 14) {
      print("ERROR: The Sentinel-1 collection is not available for the selected year, use the nearest available year");
    }
    else if (year > 19) {
      print("ERROR: The CGLC is not available for the selected year, use the nearest available year");
    }

    ////////////////////////////////////////////////////////////////////////////////////////////

    var srtm = ee.Image("USGS/SRTMGL1_003"),
        gfc = ee.Image("UMD/hansen/global_forest_change_2020_v1_8"),
        CGLC = ee.Image("COPERNICUS/Landcover/100m/Proba-V-C3/Global/20" + year)
              .select('discrete_classification');

    // Create 20x20 km bounding box around the selected point 
    var bufferForRndData = (ROI.buffer(boundingBoxSize)).bounds();
    //Map.addLayer(bufferForRndData, {}, 'bufferForRndData')

    // Create separate ascending and descending collections
    var sentinel1ASCDB = S1Collection
        .filter(ee.Filter.eq('orbitProperties_pass', 'ASCENDING'));
    var sentinel1DESCDB = S1Collection
        .filter(ee.Filter.eq('orbitProperties_pass', 'DESCENDING'));

    // Calculate aspect and slope from DEM, in radians for further calculations
    var aspect = ee.Terrain.aspect(srtm).multiply(Math.PI / 180).clip(bufferForRndData);
    var slope = ee.Terrain.slope(srtm).multiply(Math.PI / 180).clip(bufferForRndData);

    //////////////////Function to CREATE LIA for ASCENDING images//////////////////

    // Function to calculate true azimuth direction for  the near range image edge
    var createLIAASC = function(img) {

        // Reproject aspect and slope to the coordinate system of S-1 image
        // Resample using nearest neighbour method
        var aspectReproj = aspect.reproject({
            crs: img.select('VV').projection()
        });
        var slopeReproj = slope.reproject({
            crs: img.select('VV').projection()
        });

        // Get the coords as a transposed array --> [[x,y]] to [x] a [y]
        // get(0) for get the first list, beause it's a list of lists // img.geometry() = 'system:footprint'
        // based on Guido Lemoine's script available at https://code.earthengine.google.com/f358cffefd45e09d162eb58821e83205
        var coords = ee.Array(img.geometry().coordinates().get(0)).transpose();
        var crdLons = ee.List(coords.toList().get(0)); // get x coordinates
        var crdLats = ee.List(coords.toList().get(1)); // get y coordinates
        var minLon = crdLons.sort().get(0); // get min/maxes
        var maxLon = crdLons.sort().get(-1);
        var minLat = crdLats.sort().get(0);
        var maxLat = crdLats.sort().get(-1);

        // Get the coordinates of the most southwest and most northwest point of the image
        // get the X coordinate of the min Y point and subtract the minX from that to get the difference
        var Xdiff = ee.Number(crdLons.get(crdLats.indexOf(minLat))).subtract(minLon);

        // get the Y coordinate of the min X point and subtract the minY from that to get the difference
        var Ydiff = ee.Number(crdLats.get(crdLons.indexOf(minLon))).subtract(minLat);

        // Now we have a right triangle --> just use the trigonometric function
        var azimuth = (Ydiff.divide(Xdiff)).atan().multiply(180 / Math.PI).add(270.0);
        // azimuth = 360 - (90 - x)   -->   x + 270!

        var azimuthViewAngle = azimuth.subtract(270);

        // Then calculate the viewing angle 
        var azimuthViewIMG = ee.Image(azimuth.subtract(270)).rename('AzimuthLook_ASC');

        // Define the Radar incidence angle
        var s1_inc = img.select('angle').multiply(Math.PI / 180);

        // Calculation of Local incidence angle according to Teillet et al. (1985), Hinse et al. (1988) and Castel et. al (2010)
        var LIAimg = ((slopeReproj.cos().multiply(s1_inc.cos()))
                .subtract(slopeReproj.sin().multiply(s1_inc.sin().multiply((aspectReproj.subtract(azimuthViewIMG.multiply(Math.PI / 180))).cos())))).acos()
            .clip(ee.Geometry.Polygon(img.geometry().coordinates().get(0))).multiply(180 / Math.PI).rename('LIA');
        
        //*********************shadow masking******************//
        var phi_rRad = azimuthViewIMG.multiply(Math.PI/180).subtract(aspectReproj);
        var ninetyRad = ee.Image.constant(90).multiply(Math.PI/180);
        var alpha_rRad = (slopeReproj.tan().multiply(phi_rRad.cos())).atan();
        var shadowASC = alpha_rRad.gt(ee.Image.constant(-1).multiply(ninetyRad.subtract(s1_inc))).rename('shadow');
        // layover, where slope > radar viewing angle
        var layoverASC = alpha_rRad.lt(s1_inc).rename('layover');
        // combine layover and shadow
        var maskASC = layoverASC.and(shadowASC);
        var bufferedMaskASC = _erode(maskASC, 20);
        img = img.mask(bufferedMaskASC)
        
        return img.addBands([LIAimg]).setMulti({
            lookAngleAzimuth: azimuthViewAngle
        });
    };

    //////////////////Function to CREATE LIA for DESCENDING images//////////////////

    var createLIADESC = function(img) {
        var aspectReproj = aspect.reproject({
            crs: img.select('VV').projection()
        });
        var slopeReproj = slope.reproject({
            crs: img.select('VV').projection()
        });

        // Get the coords as a transposed array --> [[x,y]] to [x] a [y]
        // get(0) for get the first list, beause it's a list of lists // img.geometry() = 'system:footprint'
        // based on Guido Lemoine's script available at https://code.earthengine.google.com/f358cffefd45e09d162eb58821e83205
        var coords = ee.Array(img.geometry().coordinates().get(0)).transpose();
        var crdLons = ee.List(coords.toList().get(0)); // get x coordinates
        var crdLats = ee.List(coords.toList().get(1)); // get y coordinates
        var minLon = crdLons.sort().get(0); // get min/maxes
        var maxLon = crdLons.sort().get(-1);
        var minLat = crdLats.sort().get(0);
        var maxLat = crdLats.sort().get(-1);

        //Get the coordinates of the most southeast and most northeast point of the image
        // get the X coordinate of the min Y point and subtract the max X from that to get the difference
        var Xdiff = ee.Number(maxLon).subtract(ee.Number(crdLons.get(crdLats.indexOf(minLat))));

        // get the Y coordinate of the min X point and subtract the minY from that to get the difference
        var Ydiff = ee.Number(crdLats.get(crdLons.indexOf(maxLon))).subtract(minLat);

        // Now we have a right triangle --> just use the trigonometric functions
        var azimuth = ee.Number(90).subtract((Ydiff.divide(Xdiff)).atan().multiply(180 / Math.PI)).add(180);
        // azimuth = 90 - azimuth + 180

        var azimuthViewAngle = azimuth.add(90);

        // Then calculate the azimuth viewing angle 
        var azimuthViewIMG = ee.Image(azimuth.add(90)).rename('AzimuthLook_Desc');

        // Define the Radar incidence angle 
        var s1_inc = img.select('angle').multiply(Math.PI / 180);

        // Calculation of Local incidence angle according to Teillet et al. (1985), Hinse et al. (1988) and Castel et. al (2010)
        var LIAimg = ((slopeReproj.cos().multiply(s1_inc.cos()))
                .subtract(slopeReproj.sin().multiply(s1_inc.sin().multiply((aspectReproj.subtract(azimuthViewIMG.multiply(Math.PI / 180))).cos())))).acos()
            .clip(ee.Geometry.Polygon(img.geometry().coordinates().get(0))).multiply(180 / Math.PI).rename('LIA');

        //*********************shadow masking******************//
        var phi_rRad = azimuthViewIMG.multiply(Math.PI/180).subtract(aspectReproj);
        var ninetyRad = ee.Image.constant(90).multiply(Math.PI/180);
        var alpha_rRad = (slopeReproj.tan().multiply(phi_rRad.cos())).atan();
        var shadowDESC = alpha_rRad.gt(ee.Image.constant(-1).multiply(ninetyRad.subtract(s1_inc))).rename('shadow');
        // layover, where slope > radar viewing angle
        var layoverDESC = alpha_rRad.lt(s1_inc).rename('layover');
        // combine layover and shadow
        var maskDESC = layoverDESC.and(shadowDESC);
        var bufferedMaskDESC = _erode(maskDESC, 20);
        img = img.mask(bufferedMaskDESC)

        return img.addBands([LIAimg]).setMulti({
            lookAngleAzimuth: azimuthViewAngle
        });
    };


/////////////////function for shadow/layover masking/////////////
   // buffer function (thanks Noel)
    function _erode(img, distance) {

      var d = (img.not().unmask(1)
          .fastDistanceTransform(30).sqrt()
          .multiply(ee.Image.pixelArea().sqrt()));

      return img.updateMask(d.gt(distance));
    } 
/////////////////function for shadow/layover masking/////////////


    // Apply the function to the Sentinel1 collection
    var LIAImgASC = sentinel1ASCDB.map(createLIAASC);
    var LIAImgDESC = sentinel1DESCDB.map(createLIADESC);

    // Merge databases of Descending and Ascending images, sort by time
    var LIAImages = (LIAImgDESC.merge(LIAImgASC)).sort('system:time_start');

    ////////////////////////////////////////////////////////////////////////

    // Create a forest mask for data
    // Select pixels with >50% tree cover and mask out region with forest loss
    var GFC = gfc.select("treecover2000").updateMask(gfc.select("treecover2000").gte(50));
    
    // Hansen Global forest - Select areas with forest loss from 2000 till the selected year
    var maskedLoss = (gfc.select('lossyear').unmask().lt(1)).or(gfc.select('lossyear').unmask().gt(year));

    var maskedGFC = GFC.updateMask(maskedLoss);

    // Load the Copernicus Global Land Cover Layers and use only the selected land cover type
    var CGLC_type = CGLC.updateMask(CGLC.eq(landCoverType));

    // Create an intersection of these two land cover databases
    var CGLCAndHansen = CGLC_type.updateMask(maskedGFC.select('treecover2000'));

    // Convert CGLCAndHansen raster to vectors
    var forestsInVectors = CGLCAndHansen.reduceToVectors({scale:30, geometry: bufferForRndData});
    
    ////////////////////////////////////////////////////////////////////////

    // Get regression parameters as image property
    var getRegressionParamaters = function(img) {

        // Create 1000 random points in the 20x20km bounding box
        var randomPoints = ee.FeatureCollection.randomPoints(bufferForRndData, 1000, 40);
        var calculatedPoints = CGLCAndHansen.reduceRegions({
            collection: randomPoints,
            reducer: ee.Reducer.mean(),
            scale: 10,
        });
        // Select points which fall into the masked forest region
        var treePoints = calculatedPoints.filter(ee.Filter.notNull(['mean']));

        // Create a 20m buffer around selected tree points
        var bufferTreePointsFc = function(feature) {
            return feature.buffer(20);
        };
        var bufferTreePoints = treePoints.map(bufferTreePointsFc);

        // Intersection of buffered tree points and forest database
        var selectedPoints = bufferTreePoints.geometry().intersection(forestsInVectors.geometry(), 0.1);
        // Create a feature collection and set the area of intersected buffers as property
        var selectedPointsFinal = ee.FeatureCollection((selectedPoints.geometries().map(function(feature) {
            return ee.Feature(ee.Geometry(feature)).setMulti({
                area: ee.Geometry(feature).area().round()
            });
        })));

        // Select the area value that occurs the most often
        var mostOftenAreaValue = ee.Number(selectedPointsFinal.aggregate_array('area').reduce(ee.Reducer.mode())).round()

        // Select only forest areas which area did not change = area lying totally in the masked forest region
        var selectedPointsFinal2 = selectedPointsFinal.filter(ee.Filter.eq('area', mostOftenAreaValue));
        
        // Add DEM info about selected forest areas
        var areasDEMstats = srtm.clip(bufferForRndData).reduceRegions({
          collection: selectedPointsFinal2,
          reducer: ee.Reducer.mean(),
          scale: 30,
        });
        var elevationMean = areasDEMstats.aggregate_mean('mean');
        
        
        // Add values of image bands to the "points"
        var pointsWithValue = ee.Image(img).reduceRegions({
            collection: selectedPointsFinal2,
            reducer: ee.Reducer.mean(),
            scale: 10,
        });

        // Filter out points, which have Null values for any of the properties
        var getValues = ee.FeatureCollection(pointsWithValue.filter(ee.Filter.notNull(['VH', 'VV', 'LIA'])));
        
        // Functions to create arrays containing all the values (LIA, VH and VV) of selected points
        var LIA = getValues.aggregate_array('LIA');
        var VH = getValues.aggregate_array('VH');
        var VV = getValues.aggregate_array('VV');

        // Calculate statistics for Tukey's fences
        var perc75VV = ee.Number(VV.reduce(ee.Reducer.percentile([75])));
        var perc25VV = ee.Number(VV.reduce(ee.Reducer.percentile([25])));
        var IQRVV = perc75VV.subtract(perc25VV);
        var lowerFenceVV = perc25VV.subtract(ee.Number(1.5).multiply(IQRVV));
        var upperFenceVV = perc75VV.add(ee.Number(1.5).multiply(IQRVV));
        var perc75VH = ee.Number(VH.reduce(ee.Reducer.percentile([75])));
        var perc25VH = ee.Number(VH.reduce(ee.Reducer.percentile([25])));
        var IQRVH = perc75VH.subtract(perc25VH);
        var lowerFenceVH = perc25VH.subtract(ee.Number(1.5).multiply(IQRVH));
        var upperFenceVH = perc75VH.add(ee.Number(1.5).multiply(IQRVH));

        // Filter out outliers with Tukey's fences
        var tukeyPointsVV = pointsWithValue
        .filter(ee.Filter.lt('VV', upperFenceVV))
        .filter(ee.Filter.gt('VV', lowerFenceVV));
        
        var tukeyPointsVH = pointsWithValue
        .filter(ee.Filter.lt('VH', upperFenceVH))
        .filter(ee.Filter.gt('VH', lowerFenceVH));
        
        // Functions to create arrays containing all the values (LIA, VH and VV) 
        // of selected points after aplication of Tukey's fences
        var T_LIA_VH = tukeyPointsVH.aggregate_array('LIA');
        var T_LIA_VV = tukeyPointsVV.aggregate_array('LIA');
        var T_VH = tukeyPointsVH.aggregate_array('VH');
        var T_VV = tukeyPointsVV.aggregate_array('VV');
        
        // Calculate LIA range for VV and VH polarizations
        var LIA_range_VV = ee.Number(tukeyPointsVH.aggregate_max('LIA')).subtract(ee.Number(tukeyPointsVH.aggregate_min('LIA')));
        var LIA_range_VH = ee.Number(tukeyPointsVV.aggregate_max('LIA')).subtract(ee.Number(tukeyPointsVV.aggregate_min('LIA')));
        
        // Calculate LIA IQR for VV and VH polarizations
        var perc75LIA_VH = ee.Number(T_LIA_VH.reduce(ee.Reducer.percentile([75])));
        var perc25LIA_VH = ee.Number(T_LIA_VH.reduce(ee.Reducer.percentile([25])));
        var VH_LIAIQR = perc75LIA_VH.subtract(perc25LIA_VH);
        
        var perc75LIA_VV = ee.Number(T_LIA_VV.reduce(ee.Reducer.percentile([75])));
        var perc25LIA_VV = ee.Number(T_LIA_VV.reduce(ee.Reducer.percentile([25])));
        var VV_LIAIQR = perc75LIA_VV.subtract(perc25LIA_VV);
        
        // Create x,y arrays from lists of values
        var VHxLIA = T_LIA_VH.zip(T_VH);
        var VVxLIA = T_LIA_VV.zip(T_VV);

        // Add regression coefficient and other statistics to the image properties
        var VHregressionValues = VHxLIA.reduce(ee.Reducer.linearFit());
        var VVregressionValues = VVxLIA.reduce(ee.Reducer.linearFit());
        var VHscale = ee.Dictionary(VHregressionValues).get('scale');
        var VVscale = ee.Dictionary(VVregressionValues).get('scale');
        var VHoffset = ee.Dictionary(VHregressionValues).get('offset');
        var VVoffset = ee.Dictionary(VVregressionValues).get('offset');
        var numptsVV = tukeyPointsVV.size();
        var numptsVH = tukeyPointsVH.size();
        var VHcorrelationCoefficient = VHxLIA.reduce(ee.Reducer.pearsonsCorrelation());
        var VVcorrelationCoefficient = VVxLIA.reduce(ee.Reducer.pearsonsCorrelation());
        var VHR2 = ee.Number(ee.Dictionary(VHcorrelationCoefficient).get('correlation')).pow(2);
        var VVR2 = ee.Number(ee.Dictionary(VVcorrelationCoefficient).get('correlation')).pow(2);
        var VHpValue = ee.Number(ee.Dictionary(VHcorrelationCoefficient).get('p-value'));
        var VVpValue = ee.Number(ee.Dictionary(VVcorrelationCoefficient).get('p-value'));


        return img.setMulti({
            VVscale: VVscale,
            VHscale: VHscale,
            VVoffset: VVoffset,
            VHoffset: VHoffset,
            VVnumberOfForestPoints: numptsVV,
            VHnumberOfForestPoints: numptsVH,
            VHR2: VHR2,
            VVR2: VVR2,
            VHpValue: VHpValue,
            VVpValue: VVpValue,
            MeanElevationOfForestPoints: elevationMean,
            VV_LIAIQR: VV_LIAIQR,
            VH_LIAIQR: VH_LIAIQR,
            LIA_range_VV: LIA_range_VV,
            LIA_range_VH: LIA_range_VH
        });

    };

    // Apply the funtion to get the regression parameters as image properties
    var ImgCollWithRegression = LIAImages.map(getRegressionParamaters);

    /*if the user defined to get the mean reference LIA (9999), 
      get mean LIA for the selected point, 
      else skip and use the defined angle */
    var getLIAmax = ImgCollWithRegression.limit(ImgCollWithRegression.size()).select('LIA').max().reduceRegions({
        collection: ROI,
        reducer: ee.Reducer.mean(),
        scale: 10,
    });
    var getLIAmin = ImgCollWithRegression.limit(ImgCollWithRegression.size()).select('LIA').min().reduceRegions({
        collection: ROI,
        reducer: ee.Reducer.mean(),
        scale: 10,
    });

    if (referenceAngle == 9999) {
        var meanLIA = (getLIAmax.first().getNumber('mean').add(getLIAmin.first().getNumber('mean'))).divide(2);
        referenceAngle = meanLIA;
    }


    // Add corrected values to the Sentinel-1 ImageCollection
    var addCorrectedValues = function(img) {

        var VV = img.select('VV'),
            VH = img.select('VH'),
            VHscale = ee.Image(ee.Number(img.get('VHscale'))),
            VVscale = ee.Image(ee.Number(img.get('VVscale'))),
            angleDiff = (img.select('LIA').subtract(referenceAngle)),
            radarAngle = img.select('angle'),
            LIA = img.select('LIA');

        var corrected_VV = VV.subtract((VVscale).multiply(angleDiff))
            .rename('corrected_VV');

        var corrected_VH = VH.subtract((VHscale).multiply(angleDiff))
            .rename('corrected_VH');

        return img.addBands([corrected_VH, corrected_VV]);
    };

    // Add corrected bands to the Image Collection
    var correctedValues = ImgCollWithRegression.map(addCorrectedValues);

    return correctedValues;

};

// export the function
exports.LC_SLIAC_global = LC_SLIAC_global;
